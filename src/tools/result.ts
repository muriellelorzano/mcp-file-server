import { AppError } from "../core/errors.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  if (err instanceof AppError) {
    return {
      isError: true,
      content: [{ type: "text", text: err.message }],
      _meta: { errorType: err.name },
    };
  }
  console.error("[internal error]", err);
  return {
    isError: true,
    content: [{ type: "text", text: "Internal error" }],
    _meta: { errorType: "InternalError" },
  };
}