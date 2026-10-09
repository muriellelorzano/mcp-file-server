import type { Services } from "../core/services.js";
import {
  ListFilesSchema, type ListFilesInput,
  ReadFileSchema, type ReadFileInput,
  WriteFileSchema, type WriteFileInput,
  EditFileSchema, type EditFileInput,
  MoveFileSchema, type MoveFileInput,
  DeleteFileSchema, type DeleteFileInput,
  SearchFilesSchema, type SearchFilesInput,
} from "./schemas.js";

type Fs = Services["fs"];

export async function listFiles(
  input: ListFilesInput,
  services: Services,
): Promise<Awaited<ReturnType<Fs["list"]>>> {
  const p = ListFilesSchema.parse(input);
  return services.fs.list(p.path, p.recursive);
}

export async function readFile(
  input: ReadFileInput,
  services: Services,
): Promise<Awaited<ReturnType<Fs["read"]>>> {
  const p = ReadFileSchema.parse(input);
  return services.fs.read(p.path, p.offset, p.limit);
}

export async function writeFile(
  input: WriteFileInput,
  services: Services,
): Promise<Awaited<ReturnType<Fs["write"]>>> {
  const p = WriteFileSchema.parse(input);
  return services.fs.write(p.path, p.content, {
    expectedSha256: p.expected_sha256,
    createOnly: p.create_only,
  });
}

export async function editFile(
  input: EditFileInput,
  services: Services,
): Promise<Awaited<ReturnType<Fs["edit"]>>> {
  const p = EditFileSchema.parse(input);
  return services.fs.edit(p.path, p.old_string, p.new_string, p.expected_sha256);
}

export async function moveFile(
  input: MoveFileInput,
  services: Services,
): Promise<Awaited<ReturnType<Fs["move"]>>> {
  const p = MoveFileSchema.parse(input);
  return services.fs.move(p.from, p.to);
}

export async function deleteFile(
  input: DeleteFileInput,
  services: Services,
): Promise<Awaited<ReturnType<Fs["remove"]>>> {
  const p = DeleteFileSchema.parse(input);
  return services.fs.remove(p.path, p.expected_sha256);
}

export async function searchFiles(
  input: SearchFilesInput,
  services: Services,
): Promise<Awaited<ReturnType<Fs["search"]>>> {
  const p = SearchFilesSchema.parse(input);
  return services.fs.search(p.query, p.path, p.max_results);
}