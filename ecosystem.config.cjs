// pm2 process definition. Start with: npm run build && pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "mcp-file-server",
      script: "dist/index.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: "300M",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
      env: { NODE_ENV: "production" }, // PORT / WORKSPACE_ROOT / AUTH_TOKEN come from .env
    },
  ],
};
