"""Scan orchestration (pure). See spec.md §4."""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable, Iterable

from . import sanitize as san
from .chunking import chunk_text
from .decide import most_severe, segment_action
from .decode import decode_layers
from .errors import DetectorUnavailable, PayloadTooLarge
from .fusion import fuse
from .heuristics import SEVERITY_RANK, heuristic_score, judge_floor, load_rules, match_rules
from .html_extract import extract_html, extract_markdown
from .limits import check_limits
from .models import Classifier, Judge, JudgeResult, ScanSegment, Segment
from .normalize import INVISIBLE_FINDING_THRESHOLD, fold, normalize, strip_invisible
from .output_checks import check_output
from .policy import Policy

CORE_VERSION = "1.0.0"

JudgeMap = Callable[[Callable, Iterable], Iterable]


def _new_nonce() -> str:
    return secrets.token_hex(6)  # 12 hex chars (CORE-27)


def _ms(seconds: float) -> int:
    return int(round(seconds * 1000))


# --------------------------------------------------------------------------- pre-processing
def _preprocess(seg: Segment) -> list[ScanSegment]:
    inv = strip_invisible(seg.content)
    if seg.content_type == "html":
        parts = extract_html(inv.text)
        visible, hidden = parts.visible, parts.hidden
    elif seg.content_type == "markdown":
        parts = extract_markdown(inv.text)
        visible, hidden = parts.visible, parts.hidden
    else:
        visible, hidden = inv.text, ""
    norm = normalize(visible)
    hidden_norm = normalize(hidden)
    parent = ScanSegment(
        ref=seg.ref,
        parent_ref=seg.ref,
        source=seg.source,
        trust=seg.trust,
        content_type=seg.content_type,
        normalized=norm,
        folded=fold(norm),
        hidden_text=hidden_norm,
        invisible_count=inv.count,
        tag_text=inv.tag_text,
    )
    out = [parent]

    def derived(suffix: str, kind: str, text: str) -> ScanSegment:
        n = normalize(text)
        return ScanSegment(
            ref=f"{seg.ref}#{suffix}",
            parent_ref=seg.ref,
            source=seg.source,
            trust=seg.trust,
            content_type="text",
            normalized=n,
            folded=fold(n),
            derived_kind=kind,
        )

    if hidden_norm:
        out.append(derived("hidden", "hidden", hidden_norm))
    if inv.tag_text.strip():
        out.append(derived("tags", "tags", inv.tag_text))
    decoded: list[str] = []
    for text in (norm, hidden_norm):
        if text:
            decoded.extend(decode_layers(text))
    for i, text in enumerate(decoded):
        out.append(derived(f"decoded[{i}]", "decoded", text))
    return out


# --------------------------------------------------------------------------- findings helpers
def _finding(ref, category, severity, layer, reason, span=None, rule_id=None) -> dict:
    f = {"ref": ref, "category": category, "severity": severity, "layer": layer, "reason": reason}
    if span:
        f["span"] = span
    if rule_id:
        f["rule_id"] = rule_id
    return f


def _drop_category(root: str, findings: list[dict], segs: list[ScanSegment]) -> str:
    for s in segs:
        if s.parent_ref == root and s.judge and s.judge.label == "injection" and s.judge.category != "none":
            return s.judge.category
    best = None
    for f in findings:
        if f["ref"].split("#", 1)[0] == root and f["layer"] != "classifier":
            if best is None or SEVERITY_RANK.get(f["severity"], 0) > SEVERITY_RANK.get(best["severity"], 0):
                best = f
    return best["category"] if best else "prompt_injection"


# --------------------------------------------------------------------------- main entry points
def scan(
    segments: list[Segment],
    policy: Policy | None = None,
    classifier: Classifier | None = None,
    judge: Judge | None = None,
    *,
    nonce: str | None = None,
    rules_version: str = "v1",
    judge_map: JudgeMap | None = None,
    enforce_limits: bool = True,
    floors: dict[str, tuple[float, list[dict]]] | None = None,
) -> dict:
    """Scan segments and return a ScanResult dict (CORE-33).

    Raises PayloadTooLarge (CORE-03) or DetectorUnavailable (CORE-26, fail_mode=closed).
    """
    policy = policy or Policy()
    if enforce_limits:
        check_limits(
            [s.content for s in segments],
            sum(1 for s in segments if s.ref.startswith("context_docs")),
        )
    try:
        return _scan(segments, policy, classifier, judge, nonce or _new_nonce(), rules_version, judge_map, floors or {})
    except (PayloadTooLarge, DetectorUnavailable):
        raise
    except Exception as exc:  # whole-pipeline failure (CORE-26)
        if policy.fail_mode == "closed":
            raise DetectorUnavailable("detection pipeline failed") from exc
        return {
            "action": "allow",
            "risk_score": 0.0,
            "degraded": True,
            "segments": [],
            "findings": [],
            "sanitized": {"context_docs": []},
            "latency_ms": {"total": 0, "l1": 0, "l2": 0, "l3": 0},
            "versions": _versions(rules_version, classifier, judge, policy),
        }


def _versions(rules_version, classifier, judge, policy) -> dict:
    return {
        "core": CORE_VERSION,
        "rules": rules_version,
        "classifier": getattr(classifier, "version", None),
        "judge": getattr(judge, "model_id", None),
        "policy": policy.version,
    }


def _scan(segments, policy: Policy, classifier, judge, nonce, rules_version, judge_map, floors) -> dict:
    t0 = time.perf_counter()
    ruleset = load_rules(rules_version)
    findings: list[dict] = []
    degraded = False

    # ---- pre-processing + L1
    parents: list[ScanSegment] = []
    all_segs: list[ScanSegment] = []
    for seg in segments:
        group = _preprocess(seg)
        parents.append(group[0])
        all_segs.extend(group)

    for s in all_segs:
        matches = match_rules(
            s.normalized,
            s.folded,
            ruleset,
            deny_phrases=list(policy.deny_phrases),
            allow_phrases=list(policy.allow_phrases),
        )
        s.h, s.critical = heuristic_score(matches)
        s.floor = judge_floor(matches)
        s.rule_ids = [m.rule.id for m in matches]
        s.matches = [m.to_dict() for m in matches]
        for m in matches:
            findings.append(
                _finding(
                    s.ref,
                    m.rule.category,
                    m.rule.severity,
                    "heuristic",
                    m.rule.description,
                    span={"start": m.start, "end": m.end} if m.rule.span else None,
                    rule_id=m.rule.id,
                )
            )
        if s.derived_kind == "hidden" and matches:
            findings.append(
                _finding(
                    s.ref,
                    "hidden_instruction",
                    "high",
                    "heuristic",
                    f"Hidden HTML text contains instruction-like language: {matches[0].rule.description.lower()}.",
                )
            )
        if s.derived_kind is None:
            if s.invisible_count > INVISIBLE_FINDING_THRESHOLD:
                findings.append(
                    _finding(
                        s.ref,
                        "invisible_unicode",
                        "medium",
                        "heuristic",
                        f"Text contained {s.invisible_count} invisible Unicode characters, which were removed.",
                    )
                )
            if s.tag_text.strip():
                s.critical = True
                findings.append(
                    _finding(
                        s.ref,
                        "invisible_unicode",
                        "critical",
                        "heuristic",
                        "Text smuggles hidden ASCII using Unicode tag characters.",
                    )
                )
    t1 = time.perf_counter()

    # ---- L2 (batched, BE-13)
    classifier_failed = False
    if classifier is not None:
        chunk_lists = [chunk_text(s.normalized) for s in all_segs]
        flat = [c for cl in chunk_lists for c in cl]
        try:
            scores = list(classifier.score(flat)) if flat else []
            if len(scores) != len(flat):
                raise ValueError("classifier returned the wrong number of scores")
        except Exception:
            classifier_failed = True
            degraded = True
            for s in all_segs:
                s.c = None
        else:
            pos = 0
            for s, cl in zip(all_segs, chunk_lists):
                s.chunks = len(cl)
                s.c = round(max(float(x) for x in scores[pos : pos + len(cl)]), 6) if cl else 0.0
                pos += len(cl)
    t2 = time.perf_counter()

    # ---- L3 (gray zone + budget, CORE-17; forced on classifier failure, CORE-16)
    judge_ok = False
    candidates: list[ScanSegment] = []
    for s in all_segs:
        if s.trust == "output":
            s.judge_skip_reason = "judge is not run on output"
        elif judge is None or not policy.judge_enabled:
            s.judge_skip_reason = "judge disabled"
        elif classifier_failed or policy.gray_low <= s.p < policy.gray_high:
            candidates.append(s)
        else:
            s.judge_skip_reason = "not in gray zone"
    candidates.sort(key=lambda s: -s.p)  # stable: ties keep input order
    selected = candidates[: policy.judge_budget]
    for s in candidates[policy.judge_budget :]:
        s.judge_skip_reason = "judge budget exhausted"
    if selected:
        context = {"nonce": nonce}

        def call(s: ScanSegment) -> JudgeResult:
            try:
                return judge.assess(s, context)
            except Exception:
                return JudgeResult(label="uncertain", degraded=True, reason="Judge unavailable.")

        results = list((judge_map or map)(call, selected))
        for s, res in zip(selected, results):
            s.judge = res
            if res.degraded:
                degraded = True
            else:
                judge_ok = True
    t3 = time.perf_counter()

    if classifier_failed and not judge_ok:
        if policy.fail_mode == "closed":
            raise DetectorUnavailable("classifier unavailable and no judge result; fail_mode=closed")
        degraded = True

    # ---- fusion
    for s in all_segs:
        s.risk = fuse(s.h, s.c, s.judge, s.critical, s.floor)
        if s.c is not None and s.c >= policy.flag:
            findings.append(
                _finding(
                    s.ref,
                    "classifier_injection",
                    "high" if s.c >= policy.block else "medium",
                    "classifier",
                    f"Classifier scored this text {s.c:.2f} for injection likelihood.",
                )
            )
        if s.judge is not None and s.judge.label == "injection":
            findings.append(
                _finding(
                    s.ref,
                    s.judge.category if s.judge.category != "none" else "judge_injection",
                    "high",
                    "judge",
                    s.judge.reason or "The LLM judge labelled this text as an injection attempt.",
                )
            )

    # ---- attribution to parent refs (CORE-20)
    for p in parents:
        group = [s for s in all_segs if s.parent_ref == p.ref]
        p.risk = max(s.risk for s in group)
        if p.ref in floors:
            floor, extra = floors[p.ref]
            p.risk = max(p.risk, floor)
            findings.extend(extra)
    sanitize_modes: dict[str, str | None] = {}
    for s in all_segs:
        root = next(p for p in parents if p.ref == s.parent_ref)
        risk = root.risk if s is root else s.risk
        s.action, mode = segment_action(s.trust, risk, policy)
        if s is root:
            sanitize_modes[s.ref] = mode

    computed = most_severe([p.action for p in parents])
    request_risk = max((s.risk for s in all_segs), default=0.0)
    request_risk = max([request_risk] + [p.risk for p in parents])

    # ---- P3: every non-allow result carries a finding with a reason
    for p in parents:
        if p.action != "allow" and not any(f["ref"].split("#", 1)[0] == p.ref for f in findings):
            findings.append(
                _finding(p.ref, "risk_threshold", "medium", "fusion", f"Fused risk {p.risk:.2f} reached the {p.action} threshold.")
            )

    # ---- sanitization (CORE-27/28)
    sanitized_docs: list[str] = []
    for p in parents:
        if p.trust != "untrusted":
            continue
        mode = sanitize_modes.get(p.ref)
        if p.action == "block" or mode == "drop":
            sanitized_docs.append(san.drop(_drop_category(p.ref, findings, all_segs)))
        elif mode == "clean":
            spans = [(m["span"]["start"], m["span"]["end"]) for m in p.matches if m.get("span")]
            sanitized_docs.append(san.clean(p.ref, p.normalized, spans, nonce))
        else:
            sanitized_docs.append(san.spotlight(p.ref, p.normalized, nonce))

    t4 = time.perf_counter()
    result: dict = {
        "action": computed,
        "risk_score": round(request_risk, 4),
        "degraded": degraded,
        "segments": [_segment_dict(s, sanitize_modes.get(s.ref), classifier) for s in all_segs],
        "findings": findings,
        "sanitized": {"context_docs": sanitized_docs},
        "latency_ms": {"total": _ms(t4 - t0), "l1": _ms(t1 - t0), "l2": _ms(t2 - t1), "l3": _ms(t3 - t2)},
        "versions": _versions(rules_version, classifier, judge, policy),
    }
    if policy.mode == "monitor":
        result["action"] = "allow"
        result["would_action"] = computed
    return result


def _segment_dict(s: ScanSegment, mode: str | None, classifier) -> dict:
    if s.c is not None:
        cls = {"score": s.c, "chunks": s.chunks}
    else:
        reason = "classifier disabled" if classifier is None else "classifier unavailable"
        cls = {"score": None, "chunks": s.chunks, "skipped": reason, "skipped_reason": reason}
    if s.judge is not None:
        jd = {
            "label": s.judge.label,
            "confidence": s.judge.confidence,
            "category": s.judge.category,
            "reason": s.judge.reason,
            "degraded": s.judge.degraded,
        }
    else:
        reason = s.judge_skip_reason or "not run"
        jd = {"label": None, "skipped": reason, "skipped_reason": reason}
    d = {
        "ref": s.ref,
        "source": s.source,
        "trust": s.trust,
        "risk": round(s.risk, 4),
        "action": s.action,
        "layers": {"heuristic": {"score": round(s.h, 4), "rules": s.rule_ids}, "classifier": cls, "judge": jd},
    }
    if s.derived_kind:
        d["parent"] = s.parent_ref
        d["derived"] = s.derived_kind
    if mode:
        d["sanitize_mode"] = mode
    return d


def scan_output(
    output: str,
    policy: Policy | None = None,
    classifier: Classifier | None = None,
    *,
    canary: str | None = None,
    allowed_domains: list[str] | None = None,
    nonce: str | None = None,
    rules_version: str = "v1",
) -> dict:
    """CORE-30 … CORE-32: scan LLM output with L1+L2 plus canary/link checks."""
    policy = policy or Policy()
    check = check_output(output, canary, allowed_domains or []) if policy.output_checks else None
    floors = {}
    if check is not None and (check.critical or check.flag):
        floor = 0.95 if check.critical else policy.flag
        floors["output"] = (floor, check.findings)
    elif check is not None and check.findings:
        floors["output"] = (0.0, check.findings)
    result = scan(
        [Segment(ref="output", source="llm_output", content=output)],
        policy,
        classifier,
        None,
        nonce=nonce,
        rules_version=rules_version,
        enforce_limits=False,
        floors=floors,
    )
    result["sanitized"] = {"output": check.text if check is not None else output}
    return result
