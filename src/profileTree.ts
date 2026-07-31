import { ProfileSession } from './model';

export interface ProfileTreeRow {
  id: string;
  parentId?: string;
  name: string;
  value: number;
  flat: number;
  depth: number;
  hasChildren: boolean;
}

export function profileTreeRows(session: ProfileSession, limit = 1500): ProfileTreeRow[] {
  const rows: ProfileTreeRow[] = [];
  const visit = (
    nodes: ProfileSession['callTree'],
    parentId: string | undefined,
    depth: number
  ) => {
    for (const node of [...nodes].sort((left, right) => right.value - left.value)) {
      if (rows.length >= limit) return;
      const id = `${parentId ?? 'root'}/${rows.length}:${node.id}`;
      rows.push({
        id,
        parentId,
        name: node.name,
        value: node.value,
        flat: Math.max(
          0,
          node.value - node.children.reduce((sum, child) => sum + child.value, 0)
        ),
        depth,
        hasChildren: node.children.length > 0
      });
      visit(node.children, id, depth + 1);
    }
  };
  visit(session.callTree, undefined, 0);
  return rows;
}
