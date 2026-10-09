import { z } from "zod";

export const ListFilesSchema = z.object({
  path: z.string().default("."),
  recursive: z.boolean().default(false),
});
export type ListFilesInput = z.input<typeof ListFilesSchema>;

export const ReadFileSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().optional(),
});
export type ReadFileInput = z.input<typeof ReadFileSchema>;

export const WriteFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  expected_sha256: z.string().length(64).optional(),
  create_only: z.boolean().default(false),
});
export type WriteFileInput = z.input<typeof WriteFileSchema>;

export const EditFileSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  expected_sha256: z.string().length(64).optional(),
});
export type EditFileInput = z.input<typeof EditFileSchema>;

export const MoveFileSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type MoveFileInput = z.input<typeof MoveFileSchema>;

export const DeleteFileSchema = z.object({
  path: z.string().min(1),
  expected_sha256: z.string().length(64),
});
export type DeleteFileInput = z.input<typeof DeleteFileSchema>;

export const SearchFilesSchema = z.object({
  query: z.string().min(1),
  path: z.string().default("."),
  max_results: z.number().int().positive().optional(),
});
export type SearchFilesInput = z.input<typeof SearchFilesSchema>;