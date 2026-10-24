// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyComposerKeys } from "./draft-storage.js";

beforeEach(() => {
  sessionStorage.clear();
});

describe("legacy composer key migration", () => {
  it("moves a session draft and its lease, keeping the old keys", () => {
    sessionStorage.setItem("ohbaby:composer:/repo:s1", '{"text":"hi"}');
    sessionStorage.setItem("ohbaby:composer-lease:/repo:s1", '{"lease":1}');
    migrateLegacyComposerKeys();
    expect(sessionStorage.getItem("ohbaby:composer:s1")).toBe('{"text":"hi"}');
    expect(sessionStorage.getItem("ohbaby:composer-lease:s1")).toBe(
      '{"lease":1}',
    );
    expect(sessionStorage.getItem("ohbaby:composer:/repo:s1")).not.toBeNull();
  });

  it("moves the only new-chat draft, including a Windows directory", () => {
    sessionStorage.setItem("ohbaby:composer:C:\\repo:new", '{"text":"draft"}');
    migrateLegacyComposerKeys();
    expect(sessionStorage.getItem("ohbaby:composer:new")).toBe(
      '{"text":"draft"}',
    );
  });

  it("leaves ambiguous new-chat drafts and never moves a lease into new", () => {
    sessionStorage.setItem("ohbaby:composer:/a:new", '{"text":"a"}');
    sessionStorage.setItem("ohbaby:composer:/b:new", '{"text":"b"}');
    sessionStorage.setItem("ohbaby:composer-lease:/a:new", '{"lease":1}');
    migrateLegacyComposerKeys();
    expect(sessionStorage.getItem("ohbaby:composer:new")).toBeNull();
    expect(sessionStorage.getItem("ohbaby:composer-lease:new")).toBeNull();
  });

  it("runs once, so a sent draft does not come back from its old key", () => {
    sessionStorage.setItem("ohbaby:composer:/repo:new", '{"text":"sent"}');
    migrateLegacyComposerKeys();
    sessionStorage.removeItem("ohbaby:composer:new");
    migrateLegacyComposerKeys();
    expect(sessionStorage.getItem("ohbaby:composer:new")).toBeNull();
  });

  it("does not merge one session saved under two directories or overwrite a newer draft", () => {
    sessionStorage.setItem("ohbaby:composer:/a:s1", '{"text":"a"}');
    sessionStorage.setItem("ohbaby:composer:/b:s1", '{"text":"b"}');
    sessionStorage.setItem("ohbaby:composer:/a:s2", '{"text":"old"}');
    sessionStorage.setItem("ohbaby:composer:s2", '{"text":"new"}');
    migrateLegacyComposerKeys();
    expect(sessionStorage.getItem("ohbaby:composer:s1")).toBeNull();
    expect(sessionStorage.getItem("ohbaby:composer:s2")).toBe('{"text":"new"}');
  });
});
