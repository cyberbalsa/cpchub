"use strict";
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
    button.textContent = "Copied!";
  } catch {
    button.textContent = "Select & copy the key";
  }
});
document.addEventListener("htmx:responseError", () => {
  const results = document.getElementById("results");
  if (results) {
    const message = document.createElement("p");
    message.className = "notice";
    message.textContent = "The request could not be completed. Refresh the page to try again.";
    results.prepend(message);
  }
});
