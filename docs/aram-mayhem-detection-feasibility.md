# Detección de aumentos de ARAM Mayhem: estado y decisión

Fecha de revisión: 2026-11-05.

## Resultado real añadido: 2026-11-05

En una partida Mayhem real, LCU informó `InProgress` y queue ID `2400`; LCDA respondió por sus tres rutas probadas. `/allgamedata` informó `gameMode: KIWI` y mapa `12`. Se observaron eventos ordinarios de juego, incluidos `GameStart`, `MinionsSpawning`, `ChampionKill`, `FirstBlood`, `Multikill`, `TurretKilled`, `FirstBrick` y `Ace`. No aparecieron campos, identificadores ni eventos inequívocos de aumentos, tampoco en la muestra posterior a que el usuario informó haber elegido uno.

**Resultado registrado:** «Fuente local funcional, selección de aumentos no disponible en los datos observados».

La primera lectura de la vigilancia ya estaba en `InProgress`; por tanto el reloj de esa sesión mide desde la primera observación del monitor, no el instante exacto en que empezó la partida. La observación confirma que los endpoints locales sirven durante Mayhem, pero no permite activar el motor al elegir un aumento.

## Qué permite comprobar la vía local

Riot documenta Live Client Data durante una partida y expone `GET /liveclientdata/allgamedata`, `GET /liveclientdata/eventdata` y `GET /liveclientdata/activeplayer`. La documentación describe `/eventdata` como una lista de eventos (`EventID`, `EventName`, `EventTime`) y `activeplayer` como información del jugador activo. La documentación pública consultada no define campos de aumentos ni eventos de selección de aumentos en estas respuestas. La ausencia documental no demuestra que ningún cliente futuro o parche pueda añadir campos; por eso el diagnóstico local inspecciona los payloads actuales de manera acotada.

Ejecución durante una partida Mayhem:

```powershell
npm run diagnose:mayhem-local
npm run diagnose:mayhem-local:watch
```

El primer comando toma una muestra; `--watch` toma muestras cada 1,5 segundos hasta `Ctrl+C` y conserva únicamente hasta 100 cambios de señal. El JSON se actualiza durante la ejecución para no perder la captura si se cierra el proceso. Registra hora UTC y tiempo desde el inicio del diagnóstico, transición de fase y cola, estado/código de error de cada endpoint, nombres de eventos añadidos/eliminados, campos de aumento vistos y el tiempo en que se observó `InProgress`. En campos del jugador local bajo una clave de aumento conserva solo valores de `id`, `augmentId`, `name` o `slug` con formato acotado; de eventos solo conserva nombre, ID numérico y tiempo. Esto permite examinar candidatos, pero no certifica por sí mismo una selección.

Ambos modos consultan solo las tres rutas LCDA anteriores y, si League Client está abierto, los dos GET LCU que el proyecto ya usa (`/lol-gameflow/v1/gameflow-phase` y `/lol-gameflow/v1/session`). No consultan el endpoint champ-select fuera de fase de selección ni buscan rutas adicionales. LCU no es un servicio oficialmente soportado por Riot para terceros y sus rutas no tienen contrato estable.

El JSON de `work/mayhem-local-diagnostic.json` solo contiene fase/cola, conteos, nombres de campos/eventos y candidatos de aumento encontrados en `activePlayer` (tu jugador local). No guarda Riot IDs, nombres de jugadores, contenido bruto de eventos, builds, objetos o datos de aumentos de otros jugadores. En `/allgamedata` solo inspecciona `activePlayer` y metadatos del juego; de `allPlayers` conserva solo el conteo. No se registra ningún payload bruto.

Una ruta cuyo nombre contenga `augment` o un evento cuyo nombre indique explícitamente un aumento será una **señal candidata**, no prueba suficiente de selección confirmada. Para declarar soporte local hacen falta observaciones repetibles en una partida real que demuestren: aparición de ofertas, un evento/estado inequívoco tras escoger y relación con el jugador local. Hasta ejecutar la prueba real, no hay fuente local confirmada para selección de aumentos.

## Historial posterior

Live Client Data describe datos de la partida activa. La documentación de Riot también declara que LCU no está oficialmente soportada y no garantiza documentación completa, estabilidad ni avisos de cambios. El proyecto no usa rutas de historial no documentadas; por lo tanto no se ha confirmado una vía LCU permitida para recuperar aumentos después de terminar. `eventdata` no debe tratarse como almacenamiento de historial local durable. Riot Match-V5 puede servir para un experimento independiente de historial publicado, pero la documentación pública consultada no promete que el resultado de Mayhem contenga las elecciones de aumento; no se implementa ni se presenta como garantizado.

## Arquitectura preparada

`src/engine/aram-mayhem-event-session.cjs` define un contrato neutral al proveedor. Recibe eventos con tipo, origen, match ID, marca temporal, confirmación y, si el proveedor lo tiene, ID de evento. Acepta inicio/fin, ofertas, selección confirmada, objetos adquiridos y conectividad. Rechaza IDs de partida cruzados, descarta repeticiones y emite `onAugmentSelected` solo después de una selección confirmada. Un adaptador futuro deberá mapear su API al contrato y el consumidor podrá recalcular la recomendación y notificar a la sincronización compartida del overlay. Este módulo no se conecta a Electron ni a Riot por sí mismo.

## Overwolf GEP

La referencia vigente de League GEP documenta la función `augments`: `augments` (ofertas de Mayhem) y `picked_augment` (último aumento elegido), desde GEP 299.0. Por lo tanto GEP constituye una fuente técnicamente concreta que la API local LCDA documentada no confirma. La guía de GEP indica que OW-Electron se habilita por juego, que ciertos juegos solo están en entorno DEV, que puede requerirse `--owepm-package-channel=gep:dev`, y que DevRel debe mover el juego a PROD antes de lanzamiento. Los eventos en vivo no se almacenan; el cliente debe suscribirse pronto, mientras que la información persistente puede leerse al reconectar.

La guía de onboarding exige aprobación de la idea y whitelist de la cuenta para obtener herramientas; después, revisión DevRel/QA. La política de Overwolf vigente desde 2026-11-01 requiere monetización mediante Overwolf Ads y/o Tebex, distribución en Overwolf Appstore y excluye apps privadas/personales. Así, no puede mantenerse el objetivo actual de uso local privado **bajo las condiciones de distribución documentadas por Overwolf**. Esto no es un juicio de la política de Riot ni prueba una aprobación de Riot.

## Límites actuales

- No se ejecutó la muestra con una partida Mayhem real durante esta implementación; no existe evidencia de respuesta real a adjuntar.
- Las pruebas del prototipo GEP anterior son simulaciones de contrato y no demuestran el envío de eventos reales.
- No se ha consultado a Riot ni a Overwolf para aprobación específica del producto.
- No se migró Rift Companion estándar de Electron y no se conectó el nuevo contrato neutral a la aplicación.
