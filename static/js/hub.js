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
function updateClock() {
  const clock = document.getElementById("clock");
  if (clock) clock.textContent = new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"}).format(new Date());
}
updateClock();
setInterval(updateClock, 60000);
document.addEventListener("htmx:responseError", () => {
  const results = document.getElementById("results");
  if (results) {
    const message = document.createElement("p");
    message.className = "notice";
    message.textContent = "The request could not be completed. Refresh the page to try again.";
    results.prepend(message);
  }
});
