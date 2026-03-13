export default {
  "*.{ts,tsx}": ["biome format --write", "eslint --fix"],
  "*.{js,jsx}": ["biome format --write"],
  "*.json": ["biome format --write"],
};
