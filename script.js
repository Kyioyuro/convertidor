const pdfInput = document.querySelector("#pdf-input");
const fileLabel = document.querySelector("#file-label");
const dropZone = document.querySelector("#drop-zone");
const convertButton = document.querySelector("#convert-button");
const statusMessage = document.querySelector("#status-message");
const remainingCount = document.querySelector("#remaining-count");
const proButton = document.querySelector("#pro-button");
const loginButton = document.querySelector("#login-button");
const MAX_FREE_FILE_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 95000;

let selectedFile = null;
let remainingFreeConversions = 2;
let isPro = false;
const params = new URLSearchParams(window.location.search);

async function activatePremiumAfterPayment() {

  if (params.get("payment") !== "success") {
    return;
  }

  setStatus(
    "Verificando pago...",
    "neutral"
  );

  const waitForUser = () => {
    return new Promise((resolve) => {

      const unsubscribe = window.onAuthStateChanged(
        window.auth,
        (user) => {

          if (user) {
            unsubscribe();
            resolve(user);
          }

        }
      );

    });
  };

  try {

    const user = await waitForUser();

    const userRef = window.doc(
      window.db,
      "users",
      user.uid
    );

    await window.setDoc(userRef, {
      email: user.email,
      premium: true,
      updatedAt: Date.now()
    }, { merge: true });

    isPro = true;

    remainingCount.textContent = "Ilimitadas";

    setStatus(
      "Plan Pro activado correctamente.",
      "success"
    );

  } catch (error) {

    console.error(error);

    setStatus(
      "No se pudo activar Pro.",
      "error"
    );

  }
}

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

  if (file.size > MAX_FREE_FILE_BYTES && !isPro) {
    selectedFile = null;
    fileLabel.textContent = "El PDF supera 25 MB";
    setStatus("En el plan gratis usa PDFs de 25 MB o menos.", "error");
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

function createRequestTimeout() {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { controller, timeoutId };
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
  const { controller, timeoutId } = createRequestTimeout();
  convertButton.disabled = true;
  convertButton.textContent = "Convirtiendo...";
  setStatus(`Convirtiendo ${selectedFile.name} a ${format}. Puede tardar hasta 1 minuto.`, "neutral");

  try {
    const response = await fetch("/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-File-Name": encodeURIComponent(selectedFile.name),
        "X-Output-Format": format,
        "X-User-Plan": isPro ? "pro" : "free"
      },
      body: selectedFile,
      signal: controller.signal
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
    const message = error.name === "AbortError"
      ? "La conversion tardo demasiado. Prueba con un PDF mas pequeno o con menos paginas."
      : error.message;
    setStatus(`${message}${serverHint}`, "error");
  } finally {
    window.clearTimeout(timeoutId);
    convertButton.disabled = false;
    convertButton.textContent = "Convertir PDF";
  }
});

proButton.onclick = async (event) => {
  event.preventDefault();
  event.stopPropagation();

  try {

    setStatus("Conectando con Stripe...", "neutral");

    const response = await fetch("/api/create-stripe-checkout", {
      method: "POST"
    });
    
    const data = await response.json();

    console.log(data);

    if (!data.url) {
      throw new Error("No se pudo iniciar Stripe Checkout.");
    }

    window.location.href = data.url;

  } catch (error) {

    console.error(error);

    setStatus(
      "Error al iniciar el pago.",
      "error"
    );

  }
};

let currentUser = null;

loginButton.addEventListener("click", async () => {
  if (!window.signInWithPopup) {
  setStatus("Firebase todavía está cargando...", "error");
  return;
}
  try {
    const result = await window.signInWithPopup(
      window.auth,
      window.provider
    );

    currentUser = result.user;

    const userRef = window.doc(window.db, "users", currentUser.uid);

    const userSnap = await window.getDoc(userRef);

    if (!userSnap.exists()) {
      await window.setDoc(userRef, {
        email: currentUser.email,
        premium: false,
        createdAt: Date.now()
      });
    }

    setStatus(
      `Bienvenido ${currentUser.displayName}`,
      "success"
    );

  } catch (error) {
    console.error(error);
    setStatus("Error al iniciar sesión.", "error");
  }
});

window.addEventListener("load", () => {

  if (
    !window.auth ||
    !window.onAuthStateChanged
  ) {

    console.error("Firebase no cargó correctamente.");

    return;
  }

  window.onAuthStateChanged(window.auth, async (user) => {

    if (!user) return;

    currentUser = user;

    const userRef = window.doc(
      window.db,
      "users",
      user.uid
    );

    const userSnap = await window.getDoc(userRef);

    if (userSnap.exists()) {

      const userData = userSnap.data();

      if (userData.premium) {

        isPro = true;

        remainingCount.textContent = "Ilimitadas";

      }

    }

  });

});

async function activatePremiumAfterPayment() {

  if (params.get("payment") !== "success") {
    return;
  }

  setStatus(
    "Activando plan Pro...",
    "neutral"
  );

  try {

    let user = window.auth.currentUser;

    if (!user) {

      await new Promise((resolve) => {
        const unsubscribe = window.onAuthStateChanged(
          window.auth,
          (firebaseUser) => {

            if (firebaseUser) {
              unsubscribe();
              resolve();
            }

          }
        );
      });

      user = window.auth.currentUser;
    }

    if (!user) {
      throw new Error("No hay sesión activa.");
    }

    const userRef = window.doc(
      window.db,
      "users",
      user.uid
    );

    await window.setDoc(userRef, {
      email: user.email,
      premium: true,
      updatedAt: Date.now()
    }, { merge: true });

    isPro = true;

    remainingCount.textContent = "Ilimitadas";

    setStatus(
      "Plan Pro activado correctamente.",
      "success"
    );

  } catch (error) {

    console.error(error);

    setStatus(
      error.message || "No se pudo activar Pro.",
      "error"
    );

  }

}

window.addEventListener("load", () => {
  activatePremiumAfterPayment();
});