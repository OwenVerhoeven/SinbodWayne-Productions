import { DomainError } from "./errors";

export interface DependencyEdge<T extends string = string> {
  readonly prerequisiteId: T;
  readonly dependentId: T;
}

export function detectDependencyCycle<T extends string>(
  nodeIds: readonly T[],
  edges: readonly DependencyEdge<T>[],
): readonly T[] | null {
  if (new Set(nodeIds).size !== nodeIds.length)
    throw new DomainError("INVALID_INPUT", "Node IDs must be unique.");
  const nodes = new Set(nodeIds);
  const adjacency = new Map<T, T[]>(nodeIds.map((node) => [node, []]));
  for (const edge of edges) {
    if (!nodes.has(edge.prerequisiteId) || !nodes.has(edge.dependentId)) {
      throw new DomainError("INVALID_INPUT", "Dependency edge references an unknown node.");
    }
    adjacency.get(edge.prerequisiteId)!.push(edge.dependentId);
  }
  for (const children of adjacency.values()) children.sort();

  const state = new Map<T, "visiting" | "visited">();
  const stack: T[] = [];
  const visit = (node: T): T[] | null => {
    state.set(node, "visiting");
    stack.push(node);
    for (const child of adjacency.get(node)!) {
      if (state.get(child) === "visiting") {
        const start = stack.indexOf(child);
        return [...stack.slice(start), child];
      }
      if (state.get(child) !== "visited") {
        const cycle = visit(child);
        if (cycle !== null) return cycle;
      }
    }
    stack.pop();
    state.set(node, "visited");
    return null;
  };

  for (const node of [...nodeIds].sort()) {
    if (state.has(node)) continue;
    const cycle = visit(node);
    if (cycle !== null) return cycle;
  }
  return null;
}

export function wouldCreateDependencyCycle<T extends string>(
  nodeIds: readonly T[],
  edges: readonly DependencyEdge<T>[],
  candidate: DependencyEdge<T>,
): boolean {
  return detectDependencyCycle(nodeIds, [...edges, candidate]) !== null;
}

export function topologicalOrder<T extends string>(
  nodeIds: readonly T[],
  edges: readonly DependencyEdge<T>[],
): readonly T[] {
  const cycle = detectDependencyCycle(nodeIds, edges);
  if (cycle !== null) {
    throw new DomainError("INVARIANT_VIOLATION", "Dependency graph contains a cycle.", { cycle });
  }
  const indegree = new Map<T, number>(nodeIds.map((node) => [node, 0]));
  const adjacency = new Map<T, T[]>(nodeIds.map((node) => [node, []]));
  for (const edge of edges) {
    adjacency.get(edge.prerequisiteId)!.push(edge.dependentId);
    indegree.set(edge.dependentId, indegree.get(edge.dependentId)! + 1);
  }
  const ready = nodeIds.filter((node) => indegree.get(node) === 0).sort();
  const result: T[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    result.push(node);
    for (const child of adjacency.get(node)!.sort()) {
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  return result;
}
