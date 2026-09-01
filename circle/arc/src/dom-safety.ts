const ARC_SCAN_ORIGIN = "https://testnet.arcscan.app";

type SafeContent = Node | string;

function appendContent(parent: Element, content: SafeContent): void {
  parent.append(typeof content === "string" ? document.createTextNode(content) : content);
}

export function arcScanLink(path: "address" | "tx", value: string, label = value): HTMLAnchorElement | Text {
  const expectedLength = path === "address" ? 40 : 64;
  if (!new RegExp(`^0x[a-fA-F0-9]{${expectedLength}}$`).test(value)) {
    return document.createTextNode(label);
  }

  const anchor = document.createElement("a");
  anchor.href = `${ARC_SCAN_ORIGIN}/${path}/${value}`;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.textContent = label;
  return anchor;
}

export function renderStatus(container: HTMLElement, message: string, hash?: string, linkLabel = "ArcScan"): void {
  container.replaceChildren(document.createTextNode(message));
  if (!hash) return;

  container.append(document.createTextNode(" "), arcScanLink("tx", hash, linkLabel));
}

export function codeValue(value: string): HTMLElement {
  const code = document.createElement("code");
  code.textContent = value;
  return code;
}

export function receiptField(label: string, value: SafeContent): HTMLDivElement {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  appendContent(description, value);
  row.append(term, description);
  return row;
}

export function tableCell(value: SafeContent): HTMLTableCellElement {
  const cell = document.createElement("td");
  appendContent(cell, value);
  return cell;
}
