const pdfInput = document.querySelector("#pdf-input");
const fileLabel = document.querySelector("#file-label");
const dropZone = document.querySelector("#drop-zone");
const convertButton = document.querySelector("#convert-button");
const statusMessage = document.querySelector("#status-message");
const remainingCount = document.querySelector("#remaining-count");
const proButton = document.querySelector("#pro-button");

let selectedFile = null;
let remainingFreeConversions = 3;
let isPro = false;

function setStatus(message, type = "neutral") {
  statusMessage.textContent = message;
  statusMessage.dataset.type = type;
}

function setSelectedFile(file) {
  if (!file) return;

  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    selectedFile = null;
    fileLabel.textContent = "El archivo debe ser PDF";
    setStatus("Selecciona un archivo con extension .pdf para continuar.", "error");
    return;
  }

  selectedFile = file;
  fileLabel.textContent = file.name;
  setStatus("Archivo cargado. Elige el formato y presiona convertir.", "success");
}

pdfInput.addEventListener("change", (event) => {
  setSelectedFile(event.target.files[0]);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
});

dropZone.addEventListener("drop", (event) => {
  setSelectedFile(event.dataTransfer.files[0]);
});

convertButton.addEventListener("click", () => {
  if (!selectedFile) {
    setStatus("Primero sube un PDF para poder convertirlo.", "error");
    return;
  }

  if (!isPro && remainingFreeConversions <= 0) {
    setStatus("Llegaste al limite gratis de hoy. Activa Pro para conversiones ilimitadas.", "error");
    document.querySelector("#planes").scrollIntoView({ behavior: "smooth" });
    return;
  }

  const format = document.querySelector("input[name='format']:checked").value;
  convertButton.disabled = true;
  convertButton.textContent = "Convirtiendo...";
  setStatus(`Preparando ${selectedFile.name} como ${format}.`, "neutral");

  window.setTimeout(() => {
    if (!isPro) {
      remainingFreeConversions -= 1;
      remainingCount.textContent = remainingFreeConversions;
    }

    convertButton.disabled = false;
    convertButton.textContent = "Convertir PDF";
    setStatus(`Conversion simulada lista: ${selectedFile.name} a ${format}. Falta conectar el motor real.`, "success");
  }, 1100);
});

proButton.addEventListener("click", () => {
  isPro = true;
  remainingCount.textContent = "Ilimitadas";
  setStatus("Plan Pro activado en modo demostracion. Ahora no hay limite de conversiones.", "success");
  document.querySelector("#converter-card").scrollIntoView({ behavior: "smooth" });
});
