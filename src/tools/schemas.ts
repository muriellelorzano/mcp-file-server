import { z } from "zod";

export const ListFilesSchema = z.object({
  path: z.string().default("."),
  recursive: z.boolean().default(false),
});

export type ListFilesInput = z.infer<typeof ListFilesSchema>;

