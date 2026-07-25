/**
 * Déclarations ambiantes pour les libs d'extraction sans types publiés.
 * `pdf-parse` n'expose pas de `.d.ts` et on importe le lib interne (évite le
 * bloc « debug » de l'index). Signature minimale utilisée.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages?: number;
    info?: unknown;
  }
  function pdfParse(data: Buffer | Uint8Array, options?: unknown): Promise<PdfParseResult>;
  export default pdfParse;
}
