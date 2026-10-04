// Sonar's cognitive-complexity rule on its own. Loading the whole
// eslint-plugin-sonarjs pulls in ts-api-utils, which needs the TypeScript
// JS API that TypeScript 7 no longer has; this one rule doesn't.
import { rule } from 'eslint-plugin-sonarjs/cjs/S3776/rule.js';

export default {
  meta: { name: 'sonarjs' },
  rules: { 'cognitive-complexity': rule },
};
