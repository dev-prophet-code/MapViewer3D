# Sicherheit

Sicherheitslücken bitte **nicht** öffentlich melden, sondern über GitHubs „Report a vulnerability“ (Private Vulnerability Reporting) dieses Repositories, mit Schritten zur Reproduktion und betroffener Version.

Das Sicherheitskonzept, die Bedrohungsanalyse und die Ergebnisse von Code-Review und Penetrationstest stehen in [docs/SECURITY-CONCEPT.md](docs/SECURITY-CONCEPT.md) und [docs/REVIEW-2.0.0.md](docs/REVIEW-2.0.0.md).

Grundregeln dieses Projekts: Es gehören **nie** Tokens, Passwörter, IP-Adressen oder Zugangsdaten ins Repository. Konfiguration läuft ausschließlich über Umgebungsvariablen (`companion/.env.example` enthält nur Platzhalter). Gib dem API-Token nur die nötigen Rechte (Maps, Bases lesen; optional Realtime Data, Players lesen).
