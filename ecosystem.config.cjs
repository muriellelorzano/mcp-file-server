// Edit this one value, then: pm2 start ecosystem.config.cjs
const NGROK_DOMAIN = "YOUR-STATIC-DOMAIN.ngrok-free.app";
const PORT = 3000;

module.exports = {
  apps: [
    {
      name: "mcp-server",
      script: "dist/index.js",
      cwd: __dirname,
      node_args: "--env-file=.env",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 2000,
      time: true,
    },
    {
      name: "ngrok",
      script: "ngrok",
      interpreter: "none",
      args: `http 127.0.0.1:${PORT} --url=${NGROK_DOMAIN}`,
      cwd: __dirname,
      autorestart: true,
      restart_delay: 3000,
      time: true,
    },
  ],
};
