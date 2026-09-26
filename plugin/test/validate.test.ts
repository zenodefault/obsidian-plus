import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/utils/validate";

describe("parseEnvelope", () => {
  it("accepts a valid request", () => {
    const env = parseEnvelope('{"id":"req_1","method":"core.health","params":{}}');
    expect(env).not.toBeNull();
    expect(env?.id).toBe("req_1");
    expect(env?.method).toBe("core.health");
  });

  it("accepts a valid response", () => {
    const env = parseEnvelope(
      '{"id":"req_1","result":{"status":"ok","version":"0.1.0","protocol_version":1,"pid":1}}',
    );
    expect(env).not.toBeNull();
    expect(env?.result).toBeDefined();
  });

  it("accepts a valid error response", () => {
    const env = parseEnvelope(
      '{"id":"req_1","error":{"code":"METHOD_NOT_FOUND","message":"unknown method: x","details":{},"request_id":"req_1"}}',
    );
    expect(env).not.toBeNull();
    expect(env?.error?.code).toBe("METHOD_NOT_FOUND");
  });

  it("rejects unknown fields (deny_unknown_fields parity)", () => {
    expect(parseEnvelope('{"id":"x","method":"m","superfluous":true}')).toBeNull();
  });

  it("rejects wrong id type", () => {
    expect(parseEnvelope('{"id":123,"method":"m"}')).toBeNull();
  });

  it("rejects result and error together", () => {
    expect(
      parseEnvelope(
        '{"id":"x","result":{},"error":{"code":"INTERNAL","message":"m"}}',
      ),
    ).toBeNull();
  });

  it("rejects unknown error codes", () => {
    expect(
      parseEnvelope('{"id":"x","error":{"code":"TOTALLY_NEW","message":"m"}}'),
    ).toBeNull();
  });

  it("rejects non-object JSON and malformed JSON", () => {
    expect(parseEnvelope("[1,2,3]")).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
  });

  it("accepts a notification without id", () => {
    const env = parseEnvelope('{"method":"core.shutdown","params":{}}');
    expect(env).not.toBeNull();
    expect(env?.id).toBeUndefined();
  });
});
