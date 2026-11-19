// Builds a minimal, valid PDF from text (one string per page, lines split on \n), so the tests don't need a
// binary fixture. Text is set small so long pages still fit: pdfjs skips text that runs off the page.

export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => void objects.push(body); // object ids are 1-based, in push order
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // pages tree, filled in below once the page ids are known
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  for (const text of pages) {
    const lines = text.split("\n").map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`);
    const stream = `BT /F1 5 Tf 6 TL 36 760 Td ${lines.join(" ")} ET`;
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const contentId = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
