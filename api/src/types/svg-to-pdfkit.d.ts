declare module 'svg-to-pdfkit' {
  /** Rend une chaîne SVG dans un document PDFKit à la position (x, y). */
  function SVGtoPDF(
    doc: PDFKit.PDFDocument,
    svg: string,
    x?: number,
    y?: number,
    options?: {
      width?: number;
      height?: number;
      preserveAspectRatio?: string;
      assumePt?: boolean;
      [key: string]: unknown;
    },
  ): void;
  export default SVGtoPDF;
}
