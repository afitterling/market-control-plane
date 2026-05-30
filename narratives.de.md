# Narrative

Bewertungs-Narrative, definiert in [`src/assessments.ts`](src/assessments.ts), gruppiert nach Strategie.
Jedes Narrativ ist mit den Vorbedingungen seiner Strategie gepaart und wird über
`POST /assessments/{strategy}/{narrative}` ausgeführt.

## 📊 Value-Investing-Bewertung (`value`)

Identifiziere profitable Unternehmen, bei denen die Stimmung den Kurs gegenüber der
nachhaltigen Cashflow-Basis überkorrigiert hat.

**Vorbedingungen:** `PROFITABLE`, `PRICE_DECLINE`, `SENTIMENT_DRIVEN`, `CASH_FLOW_STABLE`, `NO_STRUCTURAL_THREAT`

| Narrativ | ID | Beschreibung | Bewertungshebel |
|----------|----|--------------|-----------------|
| 💰 Stimmungs-Überkorrektur bei profitablem Geschäft | `sentiment-overcorrection` | Stimmungsgetriebener Ausverkauf eines profitablen Unternehmens, dessen Cashflows sich nie verschlechtert haben; die Rückkehr zum fairen Wert (Mean Reversion) ist der Renditemechanismus. | DCF, EV/EBITDA, P/FCF |
| 🏰 De-Rating eines Qualitäts-Compounders | `quality-derating` | Ein robuster, renditestarker Compounder, dessen Bewertungsmultiple durch einen Wachstumsschreck oder eine Faktorrotation gestaucht wurde, während die Ökonomie intakt blieb; das Re-Rating zurück in das historische Band ist der Renditemechanismus. | Forward-KGV vs. eigenes 5J-Band, EV/EBIT, ROIC × Reinvestitionsspielraum |
| 🔄 Fehlbewertung am zyklischen Tiefpunkt | `cyclical-trough` | Ein Zykliker nahe dem Tiefpunkt seines Zyklus, bei dem der Markt die gedrückten Tiefpunkt-Gewinne als dauerhaft extrapoliert; die normalisierte Mid-Cycle-Ertragskraft zeigt die Lücke, und die Normalisierung ist der Renditemechanismus. | Normalisiertes Mid-Cycle-EPS, Kurs/materielles Buchwert vs. Zyklus, Through-Cycle-FCF / Wiederbeschaffungswert |
| 💸 Unterschätzte Kapitalrückführung | `capital-return` | Ein profitables, cash-generierendes Unternehmen, das seine Aktienzahl reduziert und/oder die Dividende erhöht – bei einer hohen FCF-Rendite, die der Markt ignoriert; die Aktienrückkauf-getriebene EPS-Akkretion plus Rendite ist der Renditemechanismus. | FCF-Rendite, rückkaufbereinigte EPS-Akkretion, Aktionärsrendite |

### Phasen — Fehlbewertung am zyklischen Tiefpunkt
- **Abwärtszyklus** — Gewinne fallen, Schätzungen werden weiter gesenkt
- **Tiefpunkt** — Gewinne gedrückt/negativ, Lagerbestände auf Höchststand, Stimmung kapituliert
- **Frühe Erholung** — Aufträge/Preise drehen, Schätzungen beginnen zu steigen

## 🚀 Katalysator-basierte Bewertung (`catalyst`)

Identifiziere vor-profitable (oder unterskalierte) Unternehmen, bei denen Umsatzwachstum,
sich verengende Verluste und operative Hebelwirkung auf einen Wendepunkt zulaufen.

**Vorbedingungen:** `REVENUE_GROWING`, `EPS_NARROWING`, `GROSS_MARGIN_STABLE`, `OPERATING_LEVERAGE`, `NO_ONE_TIME_ITEMS`, `BALANCE_SHEET_SURVIVES`

| Narrativ | ID | Beschreibung | Bewertungshebel |
|----------|----|--------------|-----------------|
| ⚡ EPS-Wendepunkt — Trendwende vom Verlust zum Gewinn | `eps-crossover` | EPS-Wendepunkt vom Verlust zum Gewinn, bei dem der Markt gezwungen wird, von einem Umsatzmultiple auf ein Gewinnmultiple umzubewerten. | EV/Umsatz → Forward-KGV-Brücke, Modell der operativen Hebelwirkung, Schätzung des Wendepunkt-Quartals |
| 📈 Margen-Wendepunkt — Freisetzung operativer Hebelwirkung | `margin-inflection` | Ein bereits profitables, umsatzwachsendes Unternehmen erreicht den Skalenpunkt, an dem eine hohe Fixkostenbasis zusätzlichen Umsatz in überproportionale Margen- und EPS-Expansion vor den Konsensschätzungen umwandelt; nach oben gerichtete Schätzungsrevisionen sind der Renditemechanismus. | Inkrementelle operative Marge, Opex-Wachstum vs. Umsatzwachstum, Forward-EPS auf normalisierten Margen |

### Phasen — EPS-Wendepunkt
- **Vor dem Wendepunkt** — Verluste verengen sich, noch nicht profitabel (z. B. TYGO)
- **Am Wendepunkt** — erster positiver EPS-Ausweis, Konsens übertroffen (z. B. TBLA Q1 2026)
- **Nach dem Wendepunkt** — anhaltende Profitabilität, Multiple-Expansion setzt sich fort

### Phasen — Margen-Wendepunkt
- **Vor dem Wendepunkt** — Umsatz wächst, Margen flach, Fixkosten werden noch absorbiert
- **Am Wendepunkt** — inkrementelle Margen springen, Schätzungsrevisionen beginnen
- **Nach dem Wendepunkt** — operative Hebelwirkung hält an, Multiple-Expansion
