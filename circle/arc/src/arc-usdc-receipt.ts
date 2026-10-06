import { formatUnits } from "viem";
import { createElement, FileCheck2, Search, Download, ExternalLink, Printer } from "lucide";
import { RECEIPT_NETWORKS, ReceiptLookupError, readUsdcReceipt, type ReceiptNetwork, type ReceiptResult } from "./arc-usdc-receipt-reader.js";
import { compareUsdcReceipt, parseReceiptExpectation, receiptReport, ReceiptExpectationError, type ReceiptComparison, type ReceiptExpectation } from "./arc-usdc-receipt-check.js";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = byId<HTMLFormElement>("receiptForm");
const network = byId<HTMLSelectElement>("network");
const hash = byId<HTMLInputElement>("receiptHash");
const wallet = byId<HTMLInputElement>("receiptWallet");
const expected = byId<HTMLInputElement>("expectedAmount");
const check = byId<HTMLButtonElement>("receiptCheck");
const download = byId<HTMLButtonElement>("download");
const print = byId<HTMLButtonElement>("print");
const status = byId("status");
let generation = 0;
let controller: AbortController | undefined;
let result: ReceiptResult | undefined;
let comparison: ReceiptComparison | undefined;

for (const [id, icon] of [["brandIcon", FileCheck2], ["searchIcon", Search], ["downloadIcon", Download], ["explorerIcon", ExternalLink], ["printIcon", Printer]] as const) {
  byId(id).append(createElement(icon, { width: 20, height: 20, "aria-hidden": "true" }));
}
const amount = (value: bigint | null) => value === null ? "확인 불가" : `${formatUnits(value, 18)} USDC`;
const signedAmount = (value: bigint | null) => value === null ? "확인 불가" : `${value > 0n ? "+" : ""}${amount(value)}`;
const localTime = (value: number) => new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "long" }).format(value);

function reset(): void {
  generation++;
  controller?.abort();
  result = undefined;
  comparison = undefined;
  wallet.setCustomValidity("");
  expected.setCustomValidity("");
  byId("result").hidden = true;
  byId("comparison").hidden = true;
  byId("summary").replaceChildren();
  byId("movements").replaceChildren();
  byId<HTMLAnchorElement>("explorer").removeAttribute("href");
  download.disabled = true;
  print.disabled = true;
  check.disabled = false;
  form.setAttribute("aria-busy", "false");
  status.textContent = "미조회";
  status.dataset.tone = "neutral";
  const chosen = RECEIPT_NETWORKS[network.value as ReceiptNetwork];
  byId("networkBadge").textContent = `${chosen.name} · ${chosen.chainId}`;
  byId("networkBadge").dataset.testnet = String(network.value === "arc-testnet");
}

function renderComparison(value: ReceiptComparison): void {
  const titles: Record<ReceiptComparison["state"], string> = {
    matched: "수취 주소·금액 일치", short: "예상 금액보다 부족", over: "예상 금액보다 많음",
    "no-inflow": "해당 주소의 입금 없음", reverted: "실패한 거래 · 입금되지 않음",
    incomplete: "이벤트 불완전 · 판정 보류", review: "복합 이동 · 추가 확인 필요",
  };
  const notes: Record<ReceiptComparison["state"], string> = {
    matched: "이 거래에서 관측된 수취 주소와 금액이 입력한 조건에 일치합니다.",
    short: "이 거래의 순유입액이 예상 금액보다 적습니다.",
    over: "이 거래의 순유입액이 예상 금액보다 많습니다.",
    "no-inflow": "입력한 수취 주소로 들어온 USDC 이동이 없습니다.",
    reverted: "거래가 되돌려졌습니다. 납부한 가스비는 입금액에 포함되지 않습니다.",
    incomplete: "누락되거나 지원하지 않는 이벤트가 있어 금액을 확정하지 않습니다.",
    review: value.reason === "mint-burn" ? "수취 주소의 발행·소각이 포함되어 일반 송금과 구분해야 합니다." : "수취 주소에서 나간 USDC도 있습니다. 경유·반환 내역을 확인해야 합니다.",
  };
  byId("comparisonTitle").textContent = titles[value.state];
  byId("comparisonNote").textContent = notes[value.state];
  byId("comparisonAddress").textContent = value.recipient;
  byId("expectedValue").textContent = amount(value.expected);
  byId("observedValue").textContent = amount(value.net);
  byId("differenceValue").textContent = signedAmount(value.difference);
  byId("comparison").dataset.tone = value.state === "matched" ? "success" : "warning";
  byId("comparison").hidden = false;
}

function render(data: ReceiptResult): void {
  const ledger = data.ledger;
  const rows: Array<[string, string]> = [
    ["네트워크", `${data.network.name} (${data.network.chainId})${data.networkId === "arc-testnet" ? " · 테스트 자산" : ""}`],
    ["거래 해시", ledger.transactionHash], ["블록", ledger.blockNumber.toString()],
    ["거래 시간", localTime(data.blockTimestamp * 1000)],
    ["경유 포함 이동액 합계", amount(ledger.gross)], ["거래 전체 가스비", amount(ledger.gasFee)],
    ["가스비 부담 주소", ledger.payer],
  ];
  if (data.wallet) rows.push(["수취·조회 주소", data.wallet], ["들어온 금액", amount(ledger.received)], ["나간 금액", amount(ledger.sent)], ["순이동액 · 가스비 제외", amount(ledger.net)]);
  for (const [label, value] of rows) {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    byId("summary").append(dt, dd);
  }
  for (const movement of ledger.movements) {
    const tr = document.createElement("tr");
    for (const text of [movement.kind === "mint" ? "발행" : movement.kind === "burn" ? "소각" : "전송", movement.from, movement.to, amount(movement.units18)]) {
      const td = document.createElement("td"); td.textContent = text; tr.append(td);
    }
    byId("movements").append(tr);
  }
  byId("emptyMovements").hidden = ledger.movements.length > 0;
  byId("resultTitle").textContent = ledger.status === "reverted" ? "실패한 거래" : ledger.complete ? "확인된 거래" : "확인된 거래 · 이동 내역 불완전";
  byId("coverage").textContent = !ledger.complete
    ? "일부 USDC 이벤트를 검증하지 못했습니다. 확인된 내역만 표시하며 합계를 제공하지 않습니다."
    : ledger.status === "reverted" ? "거래가 되돌려졌습니다. 송금은 완료되지 않았으며 가스비는 별도입니다."
      : `${ledger.movements.length}개의 USDC 이동 · 중복 이벤트 ${ledger.pairedLogs}쌍 제외${data.wallet ? " · 주소 필터 적용" : ""}`;
  byId("checkedAt").textContent = `조회 시간 ${localTime(data.checkedAt)}`;
  byId<HTMLAnchorElement>("explorer").href = `${data.network.explorer}/tx/${ledger.transactionHash}`;
  if (comparison) renderComparison(comparison);
  byId("result").hidden = false;
  download.disabled = false;
  print.disabled = false;
  status.textContent = ledger.status === "reverted" ? "거래 실패 확인" : ledger.complete ? "조회 완료" : "일부 내역 확인 불가";
  status.dataset.tone = ledger.status === "reverted" || !ledger.complete ? "warning" : "success";
}

async function lookup(): Promise<void> {
  reset();
  let expectation: ReceiptExpectation | undefined;
  try { expectation = parseReceiptExpectation(wallet.value, expected.value); }
  catch (error) {
    if (!(error instanceof ReceiptExpectationError)) throw error;
    const message = error.field === "recipient" ? "예상 금액을 대조할 수취 주소를 입력해 주세요. 영 주소는 사용할 수 없습니다." : "0보다 큰 USDC 금액을 소수점 18자리 이내로 입력해 주세요. 쉼표·지수 표기는 사용할 수 없습니다.";
    const input = error.field === "recipient" ? wallet : expected;
    input.setCustomValidity(message); input.reportValidity();
    status.textContent = message; status.dataset.tone = "warning";
    return;
  }
  const request = generation;
  controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
  check.disabled = true;
  form.setAttribute("aria-busy", "true");
  status.textContent = "거래 기록 확인 중...";
  try {
    const data = await readUsdcReceipt(network.value as ReceiptNetwork, hash.value.trim(), wallet.value.trim(), signal);
    if (request !== generation) return;
    comparison = expectation ? compareUsdcReceipt(data, expectation) : undefined;
    result = data;
    render(data);
  } catch (error) {
    if (request !== generation) return;
    const messages = {
      input: "거래 해시 또는 주소 형식을 확인해 주세요.",
      network: "RPC의 네트워크가 선택한 체인과 다릅니다. 결과를 표시하지 않습니다.",
      integrity: "거래·블록·이벤트 정보가 일치하지 않습니다. 결과를 표시하지 않습니다.",
      "not-found": "선택한 네트워크에서 확정된 거래를 찾지 못했습니다. 대기 중이거나 다른 체인의 거래일 수 있습니다.",
      unavailable: "조회에 실패했습니다. 잠시 후 다시 시도해 주세요.",
    };
    status.textContent = signal.aborted ? "조회 시간이 초과되었습니다. 다시 시도해 주세요." : messages[error instanceof ReceiptLookupError ? error.code : "unavailable"];
    status.dataset.tone = "warning";
  } finally {
    if (request === generation) { check.disabled = false; form.setAttribute("aria-busy", "false"); }
  }
}

form.addEventListener("submit", event => { event.preventDefault(); void lookup(); });
hash.addEventListener("input", reset);
wallet.addEventListener("input", reset);
expected.addEventListener("input", reset);
network.addEventListener("change", reset);
print.addEventListener("click", () => { if (result) window.print(); });
download.addEventListener("click", () => {
  if (!result) return;
  const blob = new Blob([JSON.stringify(receiptReport(result, comparison), (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = `arc-usdc-${result.network.chainId}-${result.ledger.transactionHash}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
reset();
