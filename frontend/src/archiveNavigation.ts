export type ArchiveRecord = {
  id: string;
  name: string;
  created_at: string;
  status: string;
  notes: string;
  summary: {
    pairs: number;
    accepted: number;
    mean_mm: number | null;
    std_mm: number | null;
  } | null;
};
export type ArchiveGroup = { date: string; records: ArchiveRecord[] };

export function groupArchives(records: ArchiveRecord[]): ArchiveGroup[] {
  const groups = new Map<string, ArchiveRecord[]>();
  for (const record of records) {
    const date = record.created_at.slice(0, 10);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(record);
  }
  return Array.from(groups, ([date, records]) => ({ date, records })).sort(
    (a, b) => b.date.localeCompare(a.date),
  );
}

export function archivePosition(groups: ArchiveGroup[], id: string) {
  const column = groups.findIndex((g) => g.records.some((r) => r.id === id));
  return column < 0
    ? { column: 0, row: 0 }
    : { column, row: groups[column].records.findIndex((r) => r.id === id) };
}

export function moveArchive(
  groups: ArchiveGroup[],
  id: string,
  axis: "row" | "column",
  delta: number,
) {
  if (!groups.length) return null;
  const { column, row } = archivePosition(groups, id);
  const nextColumn =
    axis === "column"
      ? (column + delta + groups.length) % groups.length
      : column;
  const records = groups[nextColumn].records;
  const nextRow =
    axis === "row"
      ? (row + delta + records.length) % records.length
      : Math.min(row, records.length - 1);
  return records[nextRow]?.id ?? null;
}
