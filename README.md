# Agente UI con OpenRouter y Stitch MCP

Agente de IA que diseña interfaces de usuario de forma autónoma:
**OpenRouter** es el "cerebro" (LLM) y **Stitch MCP** de Google son las "manos" (herramientas).

## Archivos

| Archivo | Qué hace |
|---|---|
| `agente.js` | Bucle del agente (Agentic Loop): System Prompt, User Prompt y llamadas al modelo |
| `stitch-mcp-server.js` | Servidor MCP local que conecta con Stitch (`@google/stitch-sdk`) |
| `resultados.js` | Guarda cada prueba en `resultados/prueba-<fecha-hora>/` |
| `resultados/` | Capturas (`.png`), código (`.html`) y `resumen.md` de cada prueba |

## Cómo ejecutarlo

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Crea un archivo `.env` en la raíz con tus claves:
   ```env
   OPENROUTER_API_KEY=tu_clave_de_openrouter_aqui
   STITCH_API_KEY=tu_clave_de_stitch_aqui
   ```
3. Ejecuta el agente:
   ```bash
   npm start
   ```

El agente usa modelos **gratuitos** de OpenRouter (`:free`) y, si uno está saturado, prueba con el siguiente.
Para forzar otro modelo agrega `OPENROUTER_MODEL=...` al `.env`.

## Resultado

Al terminar, el diseño queda en tu cuenta de [Stitch](https://stitch.withgoogle.com) y una copia
(captura + HTML + resumen) se guarda en la carpeta `resultados/`.
