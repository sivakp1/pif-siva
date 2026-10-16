class PifError(Exception):
    code = "INTERNAL"


class PayloadTooLarge(PifError):
    """CORE-03: an input exceeded a size limit. Never truncated silently."""

    code = "PAYLOAD_TOO_LARGE"


class PolicyError(PifError):
    """CORE-22: a policy violated a constraint. The message names the constraint."""

    code = "INVALID_REQUEST"


class DetectorUnavailable(PifError):
    """CORE-26: pipeline failure with fail_mode=closed."""

    code = "DETECTOR_UNAVAILABLE"


class ClassifierError(PifError):
    """Raised by a Classifier implementation on timeout or failure (CORE-16)."""
