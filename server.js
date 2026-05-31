const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  ServicePrincipalCredentials,
  PDFServices,
  MimeType,
  ExportPDFParams,
  ExportPDFTargetFormat,
  ExportPDFJob,
  ExportPDFResult,
  SDKError,
  ServiceUsageError,
  ServiceApiError
} = require("@adobe/pdfservices-node-sdk");
const { createCanvas, DOMMatrix, ImageData, Path2D } = require("@napi-rs/canvas");
const { Document, ImageRun, Packer, Paragraph, PageBreak } = require("docx");
const { MercadoPagoConfig, Preference } = require("mercadopago");
const Stripe = require("stripe");
const admin = require("firebase-admin");


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
  })
});

const db = admin.firestore();

const PORT = Number(process.env.PORT || 3000);
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});


const HOST = process.env.HOST || "0.0.0.0";
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024;
const MAX_PDF_PAGES = Number(process.env.MAX_PDF_PAGES || 20);
const CONVERSION_TIMEOUT_MS = Number(process.env.CONVERSION_TIMEOUT_MS || 85000);
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

globalThis.DOMMatrix = globalThis.DOMMatrix || DOMMatrix;
globalThis.ImageData = globalThis.ImageData || ImageData;
globalThis.Path2D = globalThis.Path2D || Path2D;

let pdfjsModulePromise;

function getPdfjs() {
  if (!pdfjsModulePromise) {
    const pdfjsPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsModulePromise = import(pathToFileURL(pdfjsPath).href);
  }

  return pdfjsModulePromise;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...getSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function userError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

async function verifyFirebaseUser(request) {

  const authHeader =
    request.headers.authorization;

  if (!authHeader) {
    throw userError(
      "Debes iniciar sesión.",
      401
    );
  }

  const token =
    authHeader.replace("Bearer ", "");

  const decodedToken =
    await admin.auth().verifyIdToken(token);

  return decodedToken;

}

function withTimeout(promise, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(userError(message, 408)), CONVERSION_TIMEOUT_MS);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function getSecurityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function sendText(response, statusCode, contentType, body) {
  response.writeHead(statusCode, {
    ...getSecurityHeaders(),
    "Content-Type": contentType
  });
  response.end(body);
}

function sanitizeFileName(fileName) {
  const parsed = path.parse(fileName || "convertido.pdf").name || "convertido";
  return parsed.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "convertido";
}

function getRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on("data", (chunk) => {
      total += chunk.length;

      if (total > MAX_UPLOAD_BYTES) {
        reject(userError(`El PDF supera el limite de ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`, 413));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function loadPdf(pdfBuffer) {
  const pdfjs = await getPdfjs();
  return pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    disableWorker: true,
    useSystemFonts: true
  }).promise;
}

function textItemsToParagraphs(items) {
  const paragraphs = [];
  let currentLine = [];

  for (const item of items) {
    const text = String(item.str || "").trim();
    if (text) {
      currentLine.push(text);
    }

    if (item.hasEOL && currentLine.length) {
      paragraphs.push(currentLine.join(" "));
      currentLine = [];
    }
  }

  if (currentLine.length) {
    paragraphs.push(currentLine.join(" "));
  }

  return paragraphs;
}

async function convertToDocx(pdfBuffer) {
  const pages = await renderPdfPages(pdfBuffer, "png", 1.7);
  const children = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    if (pageIndex > 0) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }

    children.push(new Paragraph({
      children: [
        new ImageRun({
          data: pages[pageIndex].buffer,
          type: "png",
          transformation: pages[pageIndex].docxSize
        })
      ]
    }));
  }

  const document = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: 360,
            right: 360,
            bottom: 360,
            left: 360
          }
        }
      },
      children
    }]
  });
  return Packer.toBuffer(document);
}

async function convertWithAdobe(pdfBuffer) {
  const tempInputPath = path.join(__dirname, `temp-${Date.now()}.pdf`);
  
  try {
    await fs.writeFile(tempInputPath, pdfBuffer);

    const credentials = new ServicePrincipalCredentials({
      clientId: process.env.PDF_SERVICES_CLIENT_ID,
      clientSecret: process.env.PDF_SERVICES_CLIENT_SECRET
    });

    const pdfServices = new PDFServices({ credentials });

    const inputAsset = await pdfServices.upload({
      readStream: fsSync.createReadStream(tempInputPath),
      mimeType: MimeType.PDF
    });

    const params = new ExportPDFParams({
      targetFormat: ExportPDFTargetFormat.DOCX
    });

    const job = new ExportPDFJob({
      inputAsset,
      params
    });

    const pollingURL = await pdfServices.submit({ job });

    const pdfServicesResponse = await pdfServices.getJobResult({
      pollingURL,
      resultType: ExportPDFResult
    });

    const resultAsset = pdfServicesResponse.result.asset;

    const streamAsset = await pdfServices.getContent({
      asset: resultAsset
    });

    const chunks = [];

    await new Promise((resolve, reject) => {
      streamAsset.readStream.on("data", chunk => chunks.push(chunk));
      streamAsset.readStream.on("end", resolve);
      streamAsset.readStream.on("error", reject);
    });

    return Buffer.concat(chunks);

  } catch (error) {
    if (
      error instanceof SDKError ||
      error instanceof ServiceUsageError ||
      error instanceof ServiceApiError
    ) {
      console.error("Adobe API Error:", error);
    } else {
      console.error("General Error:", error);
    }

    throw error;

  } finally {

    try {

      await fs.unlink(tempInputPath);

    } catch {}
  }
}

async function renderPdfPages(pdfBuffer, imageFormat, scale = 2) {
  const pdf = await loadPdf(pdfBuffer);
  const mime = imageFormat === "jpg" ? "image/jpeg" : "image/png";
  const extension = imageFormat === "jpg" ? "jpg" : "png";
  const images = [];

  if (pdf.numPages > MAX_PDF_PAGES) {
    throw userError(`Este PDF tiene ${pdf.numPages} paginas. Por ahora el limite es ${MAX_PDF_PAGES} paginas por conversion.`);
  }

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const canvasContext = canvas.getContext("2d");

    if (imageFormat === "jpg") {
      canvasContext.fillStyle = "#ffffff";
      canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    }

    await page.render({ canvasContext, viewport }).promise;

    const buffer = imageFormat === "jpg"
      ? canvas.toBuffer("image/jpeg", 92)
      : canvas.toBuffer("image/png");

    images.push({
      buffer,
      docxSize: getDocxImageSize(viewport.width, viewport.height),
      extension,
      mime,
      name: `pagina-${String(pageNumber).padStart(2, "0")}.${extension}`
    });
  }

  return images;
}

function getDocxImageSize(width, height) {
  const maxWidth = 560;
  const maxHeight = 720;
  const ratio = Math.min(maxWidth / width, maxHeight / height);

  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio)
  };
}

function makeCrcTable() {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let value = i;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[i] = value >>> 0;
  }

  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.buffer);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(file.buffer.length, 18);
    localHeader.writeUInt32LE(file.buffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, file.buffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(file.buffer.length, 20);
    centralHeader.writeUInt32LE(file.buffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + file.buffer.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

async function handleConversion(request, response) {
  try {
    const user =
    await verifyFirebaseUser(request);

    const userDoc =
      await db
        .collection("users")
        .doc(user.uid)
        .get();

    const userData =
      userDoc.exists
        ? userDoc.data()
        : {};

    const isProUser =
      userData.premium === true;

    console.log(
      "PLAN REAL:",
      isProUser ? "PRO" : "FREE"
    );

    console.log(
    "Usuario:",
    user.uid
  );
    const format = String(request.headers["x-output-format"] || "").toLowerCase();
    const contentType = String(request.headers["content-type"] || "").toLowerCase();
    const originalName = decodeURIComponent(String(request.headers["x-file-name"] || "convertido.pdf"));
    const baseName = sanitizeFileName(originalName);

    if (!contentType.includes("application/pdf")) {
      sendJson(response, 415, { error: "El archivo debe ser un PDF." });
      return;
    }

    const pdfBuffer = await getRequestBody(request);

    if (!pdfBuffer.length) {
      sendJson(response, 400, { error: "Sube un PDF para convertir." });
      return;
    }

    if (format === "word") {
      
      const docxBuffer = await withTimeout(
        isProUser
          ? convertWithAdobe(pdfBuffer)
          : convertToDocx(pdfBuffer),

        "La conversion tardo demasiado. Prueba con un PDF mas pequeno o con menos paginas."
      );
      response.writeHead(200, {
        ...getSecurityHeaders(),
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${baseName}.docx"`
      });
      response.end(docxBuffer);
      return;
    }

    if (format === "jpg" || format === "png") {
      const images = await withTimeout(
        renderPdfPages(pdfBuffer, format),
        "La conversion tardo demasiado. Prueba con un PDF mas pequeno o con menos paginas."
      );

      if (images.length === 1) {
        response.writeHead(200, {
          ...getSecurityHeaders(),
          "Content-Type": images[0].mime,
          "Content-Disposition": `attachment; filename="${baseName}.${images[0].extension}"`
        });
        response.end(images[0].buffer);
        return;
      }

      const zipBuffer = createZip(images);
      response.writeHead(200, {
        ...getSecurityHeaders(),
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${baseName}-${format}.zip"`
      });
      response.end(zipBuffer);
      return;
    }

    sendJson(response, 400, { error: "Formato no soportado." });
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, {
      error: error.expose
        ? error.message
        : "No se pudo convertir el PDF. Intenta con otro archivo o un PDF sin proteccion."
    });
  }
}

function serveRobots(response) {
  sendText(response, 200, "text/plain; charset=utf-8", [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    ""
  ].join("\n"));
}

function serveSitemap(response) {
  const today = new Date().toISOString().slice(0, 10);
  sendText(response, 200, "application/xml; charset=utf-8", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>${today}</lastmod>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/privacidad.html</loc>
    <lastmod>${today}</lastmod>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${SITE_URL}/terminos.html</loc>
    <lastmod>${today}</lastmod>
    <priority>0.6</priority>
  </url>
</urlset>
`);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const requestedPath = url.pathname === "/"
    ? "index.html"
    : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const filePath = path.resolve(__dirname, requestedPath);

  if (!filePath.startsWith(path.resolve(__dirname))) {
    sendJson(response, 403, { error: "Ruta no permitida." });
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      ...getSecurityHeaders(),
      "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
      "Content-Type": STATIC_TYPES[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: "Archivo no encontrado." });
  }
}

async function handleCreatePayment(request, response) {
  try {
    const preference = {
      items: [
        {
          title: "Convertidor PDF Pro",
          quantity: 1,
          currency_id: "MXN",
          unit_price: 39
        }
      ],

      back_urls: {
        success: `${SITE_URL}/?payment=success`,
        failure: `${SITE_URL}/?payment=failure`,
        pending: `${SITE_URL}/?payment=pending`
      },

      auto_return: "approved"
    };

    const preferenceClient = new Preference(mpClient);

    const result = await preferenceClient.create({
      body: preference
    });

    sendJson(response, 200, {
      init_point:
        result.sandbox_init_point ||
        result.body?.sandbox_init_point ||
        result.init_point ||
        result.body?.init_point
    });

  } catch (error) {
    console.error("MERCADOPAGO ERROR:");
    console.error(error);

    sendJson(response, 500, {
      error: error.message || "No se pudo crear el pago."
    });
  }
}

async function handleCreateStripeCheckout(request, response) {
  try {

    const user =
    await verifyFirebaseUser(request);
    const session = await stripe.checkout.sessions.create({
      metadata: {
        uid: user.uid
      },
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "mxn",
            product_data: {
              name: "Convertidor PDF Pro"
            },
            unit_amount: 4900
          },
          quantity: 1
        }
      ],

      mode: "payment",

      success_url: `${SITE_URL}/?payment=success`,
      cancel_url: `${SITE_URL}/?payment=cancel`,

    });

    sendJson(response, 200, {
      url: session.url
    });

  } catch (error) {

    console.error("STRIPE ERROR:");
    console.error(error);

    sendJson(response, 500, {
      error: "No se pudo crear Stripe Checkout."
    });

  }
}

async function handleStripeWebhook(request, response) {

  try {

    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks);

    const signature =
      request.headers["stripe-signature"];

    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {

      const session = event.data.object;

      const uid = session.metadata?.uid;

      if (uid) {

        await db
          .collection("users")
          .doc(uid)
          .set(
            {
              premium: true,
              updatedAt: Date.now()
            },
            { merge: true }
          );

        console.log(
          "USUARIO ACTIVADO:",
          uid
        );

      }

    }

    response.writeHead(200);
    response.end("ok");

  } catch (error) {

    console.error(
      "WEBHOOK ERROR:",
      error
    );

    response.writeHead(400);
    response.end("error");

  }

}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && request.url === "/robots.txt") {
    serveRobots(response);
    return;
  }

  if (request.method === "GET" && request.url === "/sitemap.xml") {
    serveSitemap(response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/create-payment") {
    handleCreatePayment(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/create-stripe-checkout") {
  handleCreateStripeCheckout(request, response);
  return;
}

  if (
  request.method === "POST" &&
  request.url === "/api/stripe-webhook"
) {
  handleStripeWebhook(
    request,
    response
  );
  return;
}

  if (request.method === "POST" && request.url === "/api/convert") {
    handleConversion(request, response);
    return;
  }

  if (request.method === "GET") {
    serveStatic(request, response);
    return;
  }

  sendJson(response, 405, { error: "Metodo no permitido." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PDF Cambio listo en puerto ${PORT}`);
});
