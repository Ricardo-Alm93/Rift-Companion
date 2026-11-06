# Rift Companion Mayhem: solicitud de acceso y orientación

> **Decisión de proyecto (2026-11-05): Overwolf migration is stopped.** This file is retained as historical research and an unsent draft only. Do not submit the proposal, contact DevRel, register an app, or integrate the prototype. The documented Overwolf approval, Appstore, and monetization path does not fit Rift Companion's personal, local, non-commercial open-source direction. See [Overwolf experimental status](overwolf-experimental-status.md).

Fecha de revisión: 2026-11-05.

## Estado real y alcance

**Resultado LCDA:** «Fuente local funcional, selección de aumentos no disponible en los datos observados».

Durante una partida real de Mayhem, LCU informó fase `InProgress` y cola `2400`; `/allgamedata`, `/eventdata` y `/activeplayer` respondieron. Se observaron `gameMode: KIWI`, mapa 12 y eventos de partida comunes. No se obtuvo un campo, ID o evento que identificara un aumento elegido, incluso en una muestra tomada después de que el usuario informó haber seleccionado uno. Esto no demuestra que LCDA nunca pueda añadir esa información; describe lo efectivamente observado. No se usarán endpoints LCU no documentados, heurísticas de estadísticas, OCR, capturas o memoria para suplirla.

Riot mantiene publicada la función GEP de League `augments`: `augments` (opciones ofrecidas) y `picked_augment` (último aumento elegido), desde GEP 299.0. Esto acredita disponibilidad documentada en la interfaz de Overwolf; **no acredita autorización de Riot ni confirma que la función esté habilitada en el entorno de desarrollo de esta cuenta**. [Referencia GEP de League](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/league-of-legends/)

## Pasos de acceso a Overwolf

1. Iniciar sesión o crear una cuenta de Overwolf y enviar una propuesta de app en su proceso de App Proposal. Describir Rift Companion como producto público, sus pantallas/flujo y plan de monetización, y pedir explícitamente whitelist para APIs/paquetes. La documentación dice que el acceso de paquetes requiere propuesta aprobada; la aprobación no es automática. [Fase 1: propuesta](https://dev.overwolf.com/ow-electron/getting-started/project-roadmap/)
2. Solicitar acceso a las herramientas de desarrollo de OW-Electron. La documentación ubica el acceso a herramientas y Dev Mode después de la aprobación/whitelist. [Fase 2: entorno y Dev Mode](https://dev.overwolf.com/ow-electron/getting-started/develop-your-idea/)
3. Confirmar con DevRel que League GEP, y en particular `augments`, está disponible para la app en DEV. GEP se habilita por juego; si está solo en DEV, se usa `--owepm-package-channel=gep:dev`. Antes de pasar a PROD se debe pedir a DevRel mover el juego/paquete al canal PROD.
4. Solo con acceso concedido, preparar una rama/runtime de prueba OW-Electron separado: usar `@overwolf/ow-electron` y su builder, registrar los paquetes `gep` y, si se necesita el overlay dentro del juego, `overlay`; habilitar el proveedor League y solicitar las funciones `matchState` y `augments`. Para distribuir OW-Electron, Overwolf indica que se necesita certificado de firma de código de una CA confiable.
5. Validar una partida Mayhem real en DEV: fase/cola, ofertas, `picked_augment`, reconexión, deduplicación, recalcular alternativas y sincronizar ventana principal/overlay. No considerar pruebas simuladas como validación real. Luego solicitar QA/review y acceso PROD según el proceso Overwolf.

### Restricción de distribución

Overwolf clasifica como privada la app personal/de pequeña escala que no se planea listar; su documentación dice que no aprueba apps privadas, exige Appstore para distribución y exige monetización Overwolf Ads y/o suscripción Tebex. También establece que no se distribuya públicamente fuera de su plataforma. Por tanto, **una POC privada/local no se debe asumir permitida**. Es razonable preguntarle a DevRel si una prueba interna temporal bajo una propuesta pública aprobada está permitida, pero no ejecutarla como integración Overwolf hasta recibir respuesta. [Política de apps privadas](https://dev.overwolf.com/ow-electron/getting-started/project-roadmap/), [monetización y distribución](https://dev.overwolf.com/ow-electron/monetization/overview/)

## Consulta lista para Overwolf DevRel

Enviar a `developers@overwolf.com` o por el canal de contacto indicado en la propuesta. **No se ha enviado.**

> **Asunto:** Consulta de acceso DEV/PROD a GEP `augments` para Rift Companion
>
> Hola, estoy desarrollando Rift Companion, una aplicación de escritorio de guías educativas de builds para League of Legends. Actualmente funciona en Electron estándar y no estoy solicitando que se publique o migre ahora.
>
> La referencia GEP de League documenta `augments` y `picked_augment` para ARAM Mayhem desde GEP 299. Antes de modificar el runtime quisiera confirmar:
>
> 1. ¿La función `augments` está disponible actualmente para League of Legends en OW-Electron DEV? ¿Está disponible en PROD? ¿Qué versión/canal GEP la incluye y cómo se verifica su estado para una cuenta aprobada?
> 2. ¿`picked_augment` identifica de forma fiable la elección más reciente del jugador local en Mayhem y qué límites tiene su estado tras reconexión o al perder eventos?
> 3. ¿Qué proceso exacto, formulario, materiales y estado de cuenta se requieren para habilitar OW-Electron, GEP y Dev Mode para esta aplicación?
> 4. ¿Se permite una POC de desarrollo temporal y privada, no distribuida, para validar GEP después de aprobar/whitelistear una propuesta? Si no, ¿la propuesta debe ser pública desde el inicio?
> 5. ¿La distribución final debe ser exclusiva de Overwolf Appstore y requiere ads Overwolf o suscripciones Tebex? ¿Hay excepción documentada para un prototipo personal/local?
> 6. ¿Qué paquetes mínimos, certificado de firma, QA y pasos se requieren para integrar GEP en un proyecto Electron ya existente y probar League en DEV antes de pedir PROD?
>
> El uso previsto sería leer solo los aumentos del jugador local y objetos necesarios para orientar builds; no leer memoria, automatizar acciones ni extraer información de otros jugadores. No estamos asumiendo que GEP o la revisión Overwolf sustituyan la aprobación/política de Riot.
>
> Gracias.

## Política Riot: descripción y consulta lista para Developer Portal

La política Riot exige registrar productos que sirven a jugadores aunque no usen APIs oficiales. Expresa que el producto no debe dictar decisiones, debe conservar la diversidad y puede mostrar varias opciones. También prohíbe win rates de aumentos/objetos de Arena y datos específicos de sesión que fueran desconocidos para el jugador; impide analizar jugadores que el juego oculta deliberadamente. [Política LoL de Riot](https://developer.riotgames.com/docs/lol#developer-api-policy)

La propuesta apunta a no usar estadísticas de win rate de aumentos, mostrar únicamente selecciones propias, ofrecer varias builds con explicaciones educativas y no ejecutar compras ni inputs. Aun así, la build que se adapta en vivo es información derivada de la sesión y podría influir durante la partida; requiere una respuesta de Riot antes de distribuir. La disponibilidad del evento en GEP no implica autorización de Riot.

> **Asunto/tema:** Rift Companion: guía educativa de objetos tras selección propia de aumentos Mayhem
>
> Estoy preparando la descripción de Rift Companion para el Developer Portal y quisiera orientación sobre este flujo antes de distribuirlo:
>
> - Una interfaz aprobada por Overwolf recibiría del GEP solo los aumentos que el jugador local tiene ofrecidos y el evento/estado de su aumento elegido.
> - Al confirmarse la elección, la aplicación actualizaría una guía educativa de objetos para ese campeón y esa partida, manteniendo varias alternativas con razones y costes de oportunidad; no señalaría una compra única ni una acción inmediata.
> - La aplicación no automatizaría compras, entradas de teclado, clics ni acciones del juego; no leería memoria, capturas o datos ocultos de otros jugadores.
> - No mostraría win rates de aumentos ni objetos de Arena, ni estadísticas de otros jugadores.
>
> ¿Este uso de información GEP disponible al propio jugador, combinado con recomendaciones de objetos específicas de la partida, cumple las políticas de Game Integrity? En particular, ¿se considera que una recomendación recalculada tras un aumento es “game-session-specific information previously unknown to the player” o que dicta una decisión? ¿Se permite mostrar varias alternativas neutrales y explicadas durante la partida, o la actualización debe mostrarse solo después de la partida/antes de la siguiente? ¿Qué ajustes al flujo, frecuencia, texto, modo de presentación u overlay serían necesarios? ¿Hay requisitos adicionales para registrar el producto o solicitar aprobación antes de una prueba cerrada?
>
> No asumimos que la disponibilidad técnica de GEP otorgue aprobación. Podemos proporcionar un mockup o un prototipo no distribuido para la revisión del caso.

## Cambio mínimo si ambos procesos lo autorizan

- Mantener intacta la app Electron estándar y desarrollar un host/adaptador OW-Electron separado para GEP.
- Mapear ofertas/selección GEP a `src/engine/aram-mayhem-event-session.cjs`, conservando procedencia, match ID, confirmación y deduplicación.
- En una selección inequívoca, reutilizar el motor adaptativo Mayhem y emitir el mismo estado compartido consumido por ventana principal y overlay.
- Restringir la lectura de LCDA durante este flujo a campeón/objetos propios si son necesarios; no usarla como evidencia del aumento.
- Habilitar esta ruta solo en el runtime aprobado; mantenerla apagada en la distribución Electron estándar hasta que existan autorización y prueba real.

## Componentes y criterios de aceptación

**Ya existen y se conservan:** motor/estudio Mayhem, adaptación de builds, estado compartido para UI y overlay dentro del prototipo, prototipo aislado en `src/experimental/overwolf-aram/`, contrato neutral de eventos, deduplicación y diagnóstico LCDA sanitizado.

**Aún pendientes:** aprobación/whitelist Overwolf, confirmación DEV/PROD de GEP en la cuenta, orientación explícita de Riot, runtime OW-Electron configurado, evento real `picked_augment`, recálculo y sincronización comprobados en una partida real. La detección automática Mayhem sigue **deshabilitada y no completada**. No se cambió Ranked ni el Electron estándar.
