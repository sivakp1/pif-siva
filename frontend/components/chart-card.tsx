"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableScroll, td, th } from "@/components/ui/misc";

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
}

/** Chart with an accessible data-table alternative ("View as table", FE-10). */
export function ChartCard<T>({
  title,
  description,
  rows,
  columns,
  children,
  emptyText = "No data for this period.",
}: {
  title: string;
  description?: string;
  rows: T[];
  columns: TableColumn<T>[];
  children: React.ReactNode;
  emptyText?: string;
}) {
  const [asTable, setAsTable] = React.useState(false);
  const titleId = React.useId();
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle id={titleId}>{title}</CardTitle>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        <Button variant="outline" size="sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? "View as chart" : "View as table"}
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : asTable ? (
          <TableScroll label={`${title} data`}>
            <table className="w-full border-collapse">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className={th}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c.key} className={`${td} tabular-nums`}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        ) : (
          <div role="img" aria-labelledby={titleId} className="h-64 w-full">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
