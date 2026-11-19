import { optional, type CanvasClient } from "./canvas.js";
import type { Module, ModuleItem } from "./types.js";

/**
 * A course's modules with their items. Canvas leaves `items` out of the modules list for large modules
 * (roughly more than 50 items), so those are fetched from the module's own items endpoint.
 */
export async function modulesWithItems(
  canvas: CanvasClient,
  courseId: number,
  query: Record<string, string | string[] | undefined> = {},
): Promise<Module[]> {
  const includes = ([] as string[]).concat(query.include ?? []);
  const modules = await canvas.getAll<Module>(`/courses/${courseId}/modules`, { ...query, include: ["items", ...includes.filter((i) => i !== "items")] });
  const itemInclude = includes.includes("content_details") ? ["content_details"] : undefined;
  return Promise.all(
    modules.map(async (m) => {
      if (m.items !== undefined && (m.items_count === undefined || m.items.length >= m.items_count)) return m;
      const items = await optional(
        canvas.getAll<ModuleItem>(`/courses/${courseId}/modules/${m.id}/items`, {
          include: itemInclude,
          search_term: typeof query.search_term === "string" ? query.search_term : undefined,
        }),
        m.items ?? [],
      );
      return { ...m, items };
    }),
  );
}
