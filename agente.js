import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import dotenv from "dotenv";
import { RegistroPrueba } from "./resultados.js";

// Cargar las variables del archivo .env
dotenv.config({ quiet: true });

// ── Prompts ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un Ingeniero Frontend y Experto en UX/UI.
Tu objetivo es traducir los requerimientos del usuario en interfaces funcionales
usando las herramientas de Stitch.
Reglas:
1. Analiza el requerimiento y decide qué herramientas usar.
2. Si una herramienta falla, lee el error, ajusta los parámetros y vuelve a
intentarlo.
3. Informa al usuario de tus acciones de forma concisa.
4. Cuando generate_screen_from_text termina con éxito, su respuesta ya trae la
pantalla creada (su ID, captura y HTML). No la verifiques con list_screens, porque
esa herramienta devuelve la lista vacía aunque la pantalla exista, y nunca vuelvas
a generar la misma pantalla. Si necesitas comprobarla, usa get_screen con el ID.`;

const USER_PROMPT = `Crea un proyecto nuevo y genera una pantalla de inicio de sesión con un botón azul
oscuro, la cual reciba un usuario y password, así como las opciones de
registrarse, olvidé mi contraseña y recordar sesión siempre.
Detalles adicionales:
- Diseño limpio y moderno, centrado en la pantalla, para escritorio.
- Campo de contraseña con ícono para mostrar/ocultar.
- "Recordar sesión siempre" como checkbox, "¿Olvidaste tu contraseña?" y "Registrarse" como enlaces.
- Textos de la interfaz en español.`;

// Límite de vueltas del bucle para no gastar créditos si algo sale mal
const MAX_ITERACIONES = 15;

// Modelos gratuitos de OpenRouter (sufijo ":free") que soportan herramientas.
// Si uno está saturado (429) o no disponible, se intenta con el siguiente.
// OPENROUTER_MODEL en el .env permite forzar un modelo distinto.
const MODELOS = process.env.OPENROUTER_MODEL
  ? [process.env.OPENROUTER_MODEL]
  : ["nvidia/nemotron-3-ultra-550b-a55b:free", "minimax/minimax-m3.1-flash:free", "openrouter/free"];

// Tamaño máximo (en caracteres) del resultado de una herramienta que se devuelve
// al LLM. Stitch responde con HTML, temas y URLs muy largas que disparan el costo
// de cada llamada; al modelo le basta con los IDs, títulos y estados.
const LIMITE_RESULTADO = 3000;

function resumirResultado(resultado) {
  const texto = JSON.stringify(resultado, (clave, valor) => {
    if (typeof valor !== "string") return valor;
    // El campo "text" suele traer JSON serializado: lo abrimos para recortarlo por dentro
    if (clave === "text") {
      try {
        return JSON.parse(valor);
      } catch {}
    }
    return valor.length > 200 ? `${valor.slice(0, 200)}…` : valor;
  });
  return texto.length > LIMITE_RESULTADO ? `${texto.slice(0, LIMITE_RESULTADO)}…[resultado recortado]` : texto;
}

// Llama al primer modelo gratuito que responda; si falla por saturación o
// disponibilidad, prueba con el siguiente de la lista.
async function pedirAlModelo(openai, mensajes, tools) {
  let ultimoError;
  for (const model of MODELOS) {
    try {
      const respuesta = await openai.chat.completions.create({
        model,
        messages: mensajes,
        tools,
        max_tokens: 2048, // las respuestas del agente son cortas
      });
      if (!respuesta.choices?.length) throw new Error("respuesta vacía");
      return respuesta;
    } catch (error) {
      if (error.status === 401) throw error; // clave inválida: no tiene caso reintentar
      console.log(`↪️  ${model} no disponible (${error.status ?? error.message}), probando el siguiente modelo...`);
      ultimoError = error;
    }
  }
  throw ultimoError;
}

async function iniciarAgente() {
  const claves = [process.env.OPENROUTER_API_KEY, process.env.STITCH_API_KEY];
  if (claves.some((clave) => !clave || clave.startsWith("tu_clave_"))) {
    throw new Error("Faltan OPENROUTER_API_KEY o STITCH_API_KEY en el archivo .env (reemplaza los valores de ejemplo)");
  }

  console.log("🔌 Iniciando conexión con Stitch MCP...");
  // 1. Levantar el servidor local de Stitch (stitch-mcp-server.js)
  const transport = new StdioClientTransport({
    command: "node",
    args: ["stitch-mcp-server.js"],
    env: { ...process.env }, // pasar STITCH_API_KEY al proceso hijo
  });

  const mcpClient = new Client({ name: "agente-stitch", version: "1.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  // 2. Leer y traducir las herramientas de MCP para OpenRouter
  const mcpTools = await mcpClient.listTools();
  const openRouterTools = mcpTools.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

  console.log(`✅ Conexión exitosa. ${openRouterTools.length} herramientas disponibles.`);

  // Cliente de OpenAI apuntando a OpenRouter
  const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  // Memoria de la conversación
  const mensajes = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: USER_PROMPT },
  ];
  console.log(`\n🧑 Usuario: ${USER_PROMPT}\n`);

  let tareaCompletada = false;
  let iteraciones = 0;
  const registro = new RegistroPrueba(USER_PROMPT); // lo que se guardará en resultados/

  try {
    // 3. El Bucle del Agente (Agentic Loop)
    while (!tareaCompletada && iteraciones < MAX_ITERACIONES) {
      iteraciones++;
      const respuesta = await pedirAlModelo(openai, mensajes, openRouterTools);
      registro.registrarModelo(respuesta.model);

      const mensajeModelo = respuesta.choices[0].message;
      mensajes.push(mensajeModelo);

      // Si el modelo decide usar una herramienta de Stitch
      if (mensajeModelo.tool_calls && mensajeModelo.tool_calls.length > 0) {
        if (mensajeModelo.content) console.log(`💭 Agente: ${mensajeModelo.content}`);

        for (const toolCall of mensajeModelo.tool_calls) {
          console.log(`🛠️  Acción del Agente -> Ejecutando: ${toolCall.function.name}`);

          let argumentos = {};
          try {
            argumentos = JSON.parse(toolCall.function.arguments || "{}");

            // Ejecutar la acción a través del servidor MCP local
            // (generar una pantalla puede tardar varios minutos)
            const resultado = await mcpClient.callTool(
              { name: toolCall.function.name, arguments: argumentos },
              undefined,
              { timeout: 600000 }
            );

            // Devolver el resultado de la herramienta a la memoria del LLM
            mensajes.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: resumirResultado(resultado),
            });
            registro.registrarAccion(toolCall.function.name, argumentos, resultado);

            console.log(resultado.isError ? "⚠️  La herramienta devolvió un error." : "✅ Acción completada con éxito.");
          } catch (error) {
            console.log(`⚠️  Error en la herramienta: ${error.message}. Informando al agente para que corrija...`);
            registro.registrarAccion(toolCall.function.name, argumentos, null, error);
            mensajes.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Error: ${error.message}`,
            });
          }
        }
      } else {
        // Si ya no usa herramientas, terminó el trabajo y responde con texto
        console.log(`\n🎉 Agente: ${mensajeModelo.content}`);
        registro.respuestaFinal = mensajeModelo.content;
        tareaCompletada = true;
      }
    }

    if (!tareaCompletada) console.log(`\n⏹️  Se alcanzó el límite de ${MAX_ITERACIONES} iteraciones.`);
  } finally {
    // Guardar lo que se haya logrado (aunque la prueba falle a la mitad)
    try {
      console.log("\n💾 Guardando resultados de la prueba...");
      const carpeta = await registro.guardar(mcpClient);
      console.log(`📁 Resultados guardados en: ${carpeta}`);
    } catch (error) {
      console.log(`⚠️  No se pudieron guardar los resultados: ${error.message}`);
    }
    // Cerrar siempre el servidor MCP para que el proceso termine limpio
    await mcpClient.close();
  }
}

iniciarAgente().catch((error) => {
  console.error("❌ Error:", error.message);
  process.exitCode = 1;
});
