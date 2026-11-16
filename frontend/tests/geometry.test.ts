import { describe, expect, it } from "vitest";
import { cascadeRect, fitRect, moveRect, resizeRect } from "../src/geometry";

const area = { w: 1000, h: 700 };
const min = { w: 300, h: 200 };
const start = { x: 100, y: 100, w: 400, h: 300 };

describe("moveRect", () => {
  it("desloca a janela", () => {
    expect(moveRect(start, 50, -20, area)).toEqual({ x: 150, y: 80, w: 400, h: 300 });
  });

  it("não deixa sair da área", () => {
    expect(moveRect(start, -500, -500, area)).toMatchObject({ x: 0, y: 0 });
    expect(moveRect(start, 5000, 5000, area)).toMatchObject({ x: 600, y: 400 });
  });
});

describe("resizeRect", () => {
  it("borda direita e de baixo mudam só o tamanho", () => {
    expect(resizeRect(start, "se", 40, 30, area, min)).toEqual({ x: 100, y: 100, w: 440, h: 330 });
  });

  it("borda esquerda e de cima mantêm a borda oposta parada", () => {
    const r = resizeRect(start, "nw", -40, -30, area, min);
    expect(r).toEqual({ x: 60, y: 70, w: 440, h: 330 });
    expect(r.x + r.w).toBe(start.x + start.w);
    expect(r.y + r.h).toBe(start.y + start.h);
  });

  it("borda lateral não mexe na altura", () => {
    expect(resizeRect(start, "e", 25, 999, area, min)).toEqual({ ...start, w: 425 });
    expect(resizeRect(start, "n", 999, -10, area, min)).toEqual({ ...start, y: 90, h: 310 });
  });

  it("respeita o tamanho mínimo", () => {
    expect(resizeRect(start, "se", -1000, -1000, area, min)).toMatchObject({ w: 300, h: 200 });
    const r = resizeRect(start, "nw", 1000, 1000, area, min);
    expect(r).toEqual({ x: 200, y: 200, w: 300, h: 200 });
  });

  it("não passa dos limites da área", () => {
    expect(resizeRect(start, "se", 5000, 5000, area, min)).toEqual({ x: 100, y: 100, w: 900, h: 600 });
    expect(resizeRect(start, "nw", -5000, -5000, area, min)).toEqual({ x: 0, y: 0, w: 500, h: 400 });
  });
});

describe("fitRect", () => {
  it("traz de volta a janela que ficou fora da área", () => {
    expect(fitRect({ x: 900, y: 650, w: 400, h: 300 }, area, min)).toEqual({ x: 600, y: 400, w: 400, h: 300 });
  });

  it("encolhe a janela maior que a área", () => {
    expect(fitRect({ x: 0, y: 0, w: 1400, h: 900 }, area, min)).toEqual({ x: 0, y: 0, w: 1000, h: 700 });
  });

  it("aumenta até o mínimo e cede quando a área é menor que ele", () => {
    expect(fitRect({ x: 0, y: 0, w: 50, h: 50 }, area, min)).toMatchObject({ w: 300, h: 200 });
    expect(fitRect({ x: 0, y: 0, w: 50, h: 50 }, { w: 200, h: 150 }, min)).toEqual({ x: 0, y: 0, w: 200, h: 150 });
  });
});

describe("cascadeRect", () => {
  it("abre centralizada e desloca as seguintes", () => {
    const first = cascadeRect(1, { w: 400, h: 300 }, area);
    const second = cascadeRect(2, { w: 400, h: 300 }, area);
    expect(first.x).toBe(300);
    expect(second.x - first.x).toBe(28);
    expect(second.y - first.y).toBe(28);
  });

  it("cabe em área pequena", () => {
    expect(cascadeRect(0, { w: 900, h: 600 }, { w: 500, h: 400 })).toMatchObject({ w: 468, h: 368 });
  });
});
