const pdfInput = document.querySelector("#pdf-input");
const fileLabel = document.querySelector("#file-label");
const dropZone = document.querySelector("#drop-zone");
const convertButton = document.querySelector("#convert-button");
const statusMessage = document.querySelector("#status-message");
const remainingCount = document.querySelector("#remaining-count");
const proButton = document.querySelector("#pro-button");

let selectedFile = null;
let remainingFreeConversions = 2;
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

function getDownloadName(contentDisposition, fallbackName, format) {
  const match = /filename="([^"]+)"/.exec(contentDisposition || "");

  if (match) {
    return match[1];
  }

  const extension = format === "Word" ? "docx" : format.toLowerCase();
  return `${fallbackName.replace(/\.pdf$/i, "")}.${extension}`;
}

function downloadBlob(blob, fileName) {
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
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

convertButton.addEventListener("click", async () => {
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
  setStatus(`Convirtiendo ${selectedFile.name} a ${format}.`, "neutral");

  try {
    const response = await fetch("/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-File-Name": encodeURIComponent(selectedFile.name),
        "X-Output-Format": format
      },
      body: selectedFile
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "No se pudo convertir el archivo.");
    }

    const blob = await response.blob();
    const downloadName = getDownloadName(response.headers.get("Content-Disposition"), selectedFile.name, format);
    downloadBlob(blob, downloadName);

    if (!isPro) {
      remainingFreeConversions -= 1;
      remainingCount.textContent = remainingFreeConversions;
    }

    setStatus(`Conversion lista. Se descargo ${downloadName}.`, "success");
  } catch (error) {
    const serverHint = window.location.protocol === "file:"
      ? " Abre la pagina desde http://localhost:3000 ejecutando npm start."
      : "";
    setStatus(`${error.message}${serverHint}`, "error");
  } finally {
    convertButton.disabled = false;
    convertButton.textContent = "Convertir PDF";
  }
});

proButton.addEventListener("click", () => {
  isPro = true;
  remainingCount.textContent = "Ilimitadas";
  setStatus("Plan Pro activado en modo demostracion. Ahora no hay limite de conversiones.", "success");
  document.querySelector("#converter-card").scrollIntoView({ behavior: "smooth" });
});
