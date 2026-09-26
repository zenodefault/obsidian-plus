/**
 * Sovereign Second Brain - Configuration Flags
 *
 * USE_MOCK_IPC removed (Workstream 8 wiring complete): the UI talks to the
 * real core through the protocol wrappers. Fixture data lives only in
 * src/mock/ for component-level stories and is never imported by views.
 */

export const USE_MOCK_IPC = false;
