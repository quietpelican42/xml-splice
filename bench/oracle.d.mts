export interface Target {
  path: number[];
  name?: string;
  newName?: string;
  /** The exact bytes an ideal, minimal edit produces. */
  expected: string;
}
export type Targets = Partial<Record<'setText' | 'setAttr' | 'removeAttr' | 'insertElement' | 'removeElement' | 'rename', Target>> & { error?: string };
export function targets(source: string): Targets;
