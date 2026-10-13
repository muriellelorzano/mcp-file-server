module.exports = {
  apps: [
    {
      name: "mcp-server",
      script: "dist/index.js",
      cwd: __dirname,
      node_args: "--env-file=.env",
      env: { NODE_ENV: "production" },
    },
  ],
};