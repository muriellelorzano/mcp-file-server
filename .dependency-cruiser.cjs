/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "tools-must-not-touch-fs-or-processes",
      severity: "error",
      from: { path: "^src/tools/" },
      to: {
        path: "^(node:fs|node:child_process|node:process)",
      },
      comment: "Tools layer must delegate all I/O to services. Use src/core/services.ts instead.",
    },
    {
      name: "no-circular",
      severity: "warn",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
