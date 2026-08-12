import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Jama-Antworten sind bewusst schwach typisiert — die API liefert je nach
      // Version und Konfiguration zusaetzliche Felder.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // Geheimnisse duerfen nie ueber console ausgegeben werden; dafuer gibt
          // es den Logger mit seiner redact-Liste.
          selector: "MemberExpression[object.name='console'][property.name='log']",
          message: 'Statt console.log den Logger aus shared/logger.ts verwenden.',
        },
      ],
    },
  },
  { ignores: ['dist/**', 'web/**', 'node_modules/**', 'drizzle/**'] },
];
