# AODP DOCUMENT ENGINE ARCHITECTURE

## Objective

Generate every official business document from Sales Order.

## Architecture

Sales Order \| Document Engine \|-- Purchase Order \|-- Faktur \|--
Delivery Order \|-- Invoice \|-- Faktur Pajak \|-- Receipt

## Engine Responsibilities

-   Validation
-   Snapshot
-   Server-side calculation
-   Audit logging
-   Preview generation
-   Print rendering

## Future Ready

Support PDF, browser print, dot matrix, laser printer, and additional
document templates without changing Sales Order logic.
