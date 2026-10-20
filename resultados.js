// Guarda el resultado de cada prueba del agente en su propia carpeta:
//   resultados/prueba-AAAA-MM-DD_HH-MM-SS/
//     resumen.md        -> prompt, modelo, acciones ejecutadas y respuesta final
//     pantalla-1.png    -> captura de cada pantalla generada en Stitch
//     pantalla-1.html   -> código HTML de cada pantalla
import fs from "fs";
import path from "path";

const CARPETA_RESULTADOS = "resultados";

function marcaDeTiempo(fecha) {
  const dos = (n) => String(n).padStart(2, "0");
  return (
    `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}_` +
    `${dos(fecha.getHours())}-${dos(fecha.getMinutes())}-${dos(fecha.getSeconds())}`
  );
}

// El texto de los resultados de Stitch suele ser JSON serializado
function leerJson(resultado) {
  try {
    return JSON.parse(resultado?.content?.[0]?.text ?? "");
  } catch {
    return null;
  }
}

// Recorre la respuesta buscando pantallas (objetos con captura o código HTML)
function buscarPantallas(nodo, encontradas = []) {
  if (!nodo || typeof nodo !== "object") return encontradas;
  const captura = nodo.screenshot?.name;
  const html = (nodo.htmlCode ?? nodo.html_code)?.name;
  if (captura || html) encontradas.push({ titulo: nodo.title, captura, html });
  for (const valor of Object.values(nodo)) buscarPantallas(valor, encontradas);
  return encontradas;
}

export class RegistroPrueba {
  constructor(prompt) {
    this.inicio = new Date();
    this.prompt = prompt;
    this.modelos = new Set();
    this.acciones = [];
    this.proyectos = new Set();
    this.pantallas = new Map(); // clave: nombre de la captura o del HTML
    this.respuestaFinal = null;
  }

  registrarModelo(modelo) {
    this.modelos.add(modelo);
  }

  registrarAccion(herramienta, argumentos, resultado, error) {
    const estado = error ? `error: ${error.message}` : resultado?.isError ? "la herramienta devolvió un error" : "ok";
    this.acciones.push({ herramienta, estado });
    if (error || resultado?.isError) return;

    // Proyectos con los que trabajó el agente (no los de list_projects)
    const fuentes = [JSON.stringify(argumentos)];
    if (herramienta === "create_project") fuentes.push(resultado?.content?.[0]?.text ?? "");
    for (const texto of fuentes) {
      for (const [, id] of texto.matchAll(/projects\/(\d+)/g)) this.proyectos.add(id);
    }
    if (argumentos.projectId) this.proyectos.add(String(argumentos.projectId).replace("projects/", ""));

    for (const pantalla of buscarPantallas(leerJson(resultado))) {
      this.pantallas.set(pantalla.captura ?? pantalla.html, pantalla);
    }
  }

  async guardar(mcpClient) {
    const carpeta = path.join(CARPETA_RESULTADOS, `prueba-${marcaDeTiempo(this.inicio)}`);
    fs.mkdirSync(carpeta, { recursive: true });

    const archivos = [];
    const descargar = async (nombreArchivo, destino) => {
      try {
        const r = await mcpClient.callTool({ name: "download_file", arguments: { name: nombreArchivo } }, undefined, { timeout: 120000 });
        const datos = r.structuredContent ?? leerJson(r) ?? {};
        if (datos.image) fs.writeFileSync(path.join(carpeta, destino), Buffer.from(datos.image, "base64"));
        else if (datos.html) fs.writeFileSync(path.join(carpeta, destino), datos.html);
        else return;
        archivos.push(destino);
      } catch (error) {
        console.log(`⚠️  No se pudo descargar ${destino}: ${error.message}`);
      }
    };

    // 1. Pantallas generadas durante la prueba
    let n = 0;
    for (const pantalla of this.pantallas.values()) {
      n++;
      if (pantalla.captura) await descargar(pantalla.captura, `pantalla-${n}.png`);
      if (pantalla.html) await descargar(pantalla.html, `pantalla-${n}.html`);
    }

    // 2. Si no se capturó ninguna pantalla (p. ej. por un timeout), usar la miniatura del proyecto
    if (archivos.length === 0) {
      for (const id of this.proyectos) {
        try {
          const proyecto = leerJson(await mcpClient.callTool({ name: "get_project", arguments: { name: `projects/${id}` } }));
          if (proyecto?.thumbnailScreenshot?.name) await descargar(proyecto.thumbnailScreenshot.name, `proyecto-${id}.png`);
        } catch {}
      }
    }

    fs.writeFileSync(path.join(carpeta, "resumen.md"), this.resumen(archivos));
    return carpeta;
  }

  resumen(archivos) {
    const lista = (items) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (ninguno)");
    return `# Prueba del agente — ${this.inicio.toLocaleString("es-MX")}

**Modelo(s) usado(s):** ${[...this.modelos].join(", ") || "(ninguno)"}

## Prompt
${this.prompt}

## Acciones del agente
${this.acciones.map((a, i) => `${i + 1}. \`${a.herramienta}\` → ${a.estado}`).join("\n") || "- (ninguna)"}

## Proyecto(s) en Stitch
${lista([...this.proyectos].map((id) => `\`projects/${id}\``))}

## Archivos guardados
${lista(archivos.map((a) => `[${a}](${a})`))}

## Respuesta final del agente
${this.respuestaFinal ?? "(el agente no llegó a dar una respuesta final)"}
`;
  }
}
