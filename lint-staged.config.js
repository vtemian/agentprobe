export default {
  "*.{ts,tsx}": ["biome check --write", "eslint --fix"],
  "*.{js,jsx}": ["biome check --write"],
  "*.json": ["biome check --write"],
};
