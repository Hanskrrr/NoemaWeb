// pdf.js in the browser, loaded from the server (/api/pdfjs/...), so it is
// the very version the server reads PDFs with: the same text items on both
// sides, which is what lets a selection on a drawn page become a passage of
// the stored text (see core's pdf.ts). Loaded only when a PDF is opened.
//
// Only the few parts of pdf.js used here are typed, by hand.

export interface PdfViewport {
  width: number;
  height: number;
  scale: number;
}

export interface PdfTextContent {
  items: Array<{ str?: string; transform?: number[]; width?: number }>;
}

export interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  getTextContent(): Promise<PdfTextContent>;
  render(o: { canvas: HTMLCanvasElement; viewport: PdfViewport }): { promise: Promise<void>; cancel(): void };
  cleanup(): void;
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface TextLayerInstance {
  render(): Promise<void>;
  cancel(): void;
  readonly textDivs: HTMLElement[];
}

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
  TextLayer: new (o: { textContentSource: PdfTextContent; container: HTMLElement; viewport: PdfViewport }) => TextLayerInstance;
}

const BASE = '/api/pdfjs';
let loading: Promise<PdfjsModule> | null = null;

/** pdf.js itself, once. */
export function pdfjs(): Promise<PdfjsModule> {
  if (!loading) {
    // A URL in a variable: neither bundler takes it in; the browser fetches it from the server.
    const url = `${BASE}/build/pdf.min.mjs`;
    loading = (import(/* @vite-ignore */ url) as Promise<PdfjsModule>).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${BASE}/build/pdf.worker.min.mjs`;
      return lib;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

const documents = new Map<string, Promise<PdfDocument>>();

/** A PDF version's document, opened once per page load (the file is immutable). */
export function openPdf(fileUrl: string): Promise<PdfDocument> {
  let doc = documents.get(fileUrl);
  if (!doc) {
    doc = (async () => {
      const lib = await pdfjs();
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`the PDF could not be fetched (${res.status})`);
      const data = new Uint8Array(await res.arrayBuffer());
      return lib.getDocument({
        data,
        cMapUrl: `${BASE}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${BASE}/standard_fonts/`,
        wasmUrl: `${BASE}/wasm/`,
        iccUrl: `${BASE}/iccs/`,
        // The page's policy allows no WebAssembly: pdf.js uses its script decoders instead.
        useWasm: false,
        enableXfa: false,
      }).promise;
    })();
    documents.set(fileUrl, doc);
    doc.catch(() => documents.delete(fileUrl));
  }
  return doc;
}

export async function textLayer(
  container: HTMLElement,
  content: PdfTextContent,
  viewport: PdfViewport,
): Promise<HTMLElement[]> {
  const lib = await pdfjs();
  const layer = new lib.TextLayer({ textContentSource: content, container, viewport });
  await layer.render();
  return layer.textDivs;
}
