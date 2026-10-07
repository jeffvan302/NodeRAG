export const concludedRuntimeLicense = (name, version, declaredLicense) => {
  if (
    name === 'dompurify' &&
    (version === '3.4.14' || version === '3.4.15') &&
    declaredLicense === '(MPL-2.0 OR Apache-2.0)'
  ) {
    return 'Apache-2.0';
  }
  if (name === 'khroma' && version === '2.1.0' && declaredLicense === 'Unknown') {
    return 'MIT';
  }
  if (
    name === 'jszip' &&
    (version === '3.10.1' || version === '3.10.2') &&
    declaredLicense === '(MIT OR GPL-3.0-or-later)'
  ) {
    return 'MIT';
  }
  if (name === 'pako' && version === '1.0.11' && declaredLicense === '(MIT AND Zlib)') {
    return 'MIT';
  }
  return declaredLicense;
};

export const reviewedRuntimeLicenseNotes = [
  'DOMPurify 3.4.14 and 3.4.15 are dual-licensed; NodeRag redistributes them under Apache-2.0.',
  'khroma 2.1.0 omits the license field in its package metadata, but its bundled and upstream license file is the MIT License.',
  'JSZip 3.10.1 and 3.10.2 are dual-licensed; NodeRag redistributes them under the MIT option stated in their bundled license.',
  'pako 1.0.11 includes a bundled MIT license; NodeRag uses that exact reviewed package under MIT.',
  '@fontsource/noto-sans 5.3.0 font subsets are embedded and redistributed under OFL-1.1; the complete font notice and license must ship with NodeRag.',
  'argparse 3.0.2 is redistributed under PSF-2.0; its copyright notice and complete license must ship with NodeRag.',
  'robust-predicates 3.0.3 uses the Unlicense public-domain dedication and is permitted by the runtime policy.',
];
