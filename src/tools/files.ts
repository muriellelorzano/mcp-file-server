import type { Services } from "../core/services.js";
import { ListFilesSchema, type ListFilesInput } from "./schemas.js";

export async function listFiles(
  input: ListFilesInput,
  services: Services,
): Promise<Awaited<ReturnType<Services["fs"]["list"]>>> {
  const parsed = ListFilesSchema.parse(input);
  return services.fs.list(parsed.path, parsed.recursive);
}

