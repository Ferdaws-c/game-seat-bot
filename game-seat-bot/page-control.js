(() => {
  if (location.hostname !== "orion.iku.edu.tr" || location.port !== "8443") return;

  // This runs in the page's main JavaScript world, where SAP UI5 is available.
  // The isolated content script identifies the exact row and verifies its state.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const type = event.data?.type;
    if (type !== "iku-seat-bot:select-radio" && type !== "iku-seat-bot:press-basket") return;
    const id = event.data.id;
    if (typeof id !== "string" || !/^[-\w]+$/.test(id)) return;
    const element = document.getElementById(id);
    const control = window.sap?.ui?.getCore?.()?.byId?.(id);
    if (type === "iku-seat-bot:select-radio") {
      if (element?.getAttribute("role") !== "radio" || !element.closest("#lineItemList-tblBody")) return;
      if (control?.getDomRef?.() !== element || typeof control.setSelected !== "function" || typeof control.fireSelect !== "function") return;
      if (control.getSelected?.()) return;
      control.setSelected(true);
      control.fireSelect({ selected: true });
      return;
    }

    let ok = false;
    let error = "The SAP basket button was unavailable";
    try {
      if (element?.tagName === "BUTTON" && element.textContent?.trim() === "Kayıt sepetine ekle" &&
          control?.getDomRef?.() === element && control.getEnabled?.() && typeof control.firePress === "function") {
        control.firePress();
        ok = true;
        error = "";
      }
    } catch (cause) { error = cause?.message || String(cause); }
    window.postMessage({ type: "iku-seat-bot:press-result", requestId: event.data.requestId, ok, error }, location.origin);
  });
})();
