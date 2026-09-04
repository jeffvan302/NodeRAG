module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'shared-is-foundational',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: { path: '^(packages/(server|ui)|adapters)/' },
    },
    {
      name: 'adapters-do-not-depend-on-apps',
      severity: 'error',
      from: { path: '^adapters/' },
      to: { path: '^packages/(server|ui)/' },
    },
    {
      name: 'ui-does-not-reach-server-or-platform',
      severity: 'error',
      from: { path: '^packages/ui/' },
      to: { path: '^(packages/server|adapters)/' },
    },
    {
      name: 'adapter-peers-are-isolated',
      severity: 'error',
      from: { path: '^adapters/([^/]+)/' },
      to: { path: '^adapters/', pathNot: '^adapters/$1/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(test|dist|node_modules|spk/vendor)/' },
    includeOnly: '^(packages|adapters|scripts)/',
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
};
