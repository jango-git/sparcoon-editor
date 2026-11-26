/**
 * The Camera tab of the viewport's right-hand panel: the viewport camera's position, the point it
 * orbits and looks at, and its vertical field of view. The fields follow the camera as it moves,
 * and an edit moves it, held to the orbit's distance and height limits.
 */

import { t } from "../../i18n";
import { NumberControl } from "../components/numberControl";
import type { ViewportCamera } from "../viewportCamera";
import { axisSection, axisTriplet, fieldSection, readTriplet, setTriplet } from "./axisFields";

const MIN_FOV = 1;
const MAX_FOV = 179;

export function createCameraTabContent(camera: ViewportCamera): HTMLElement[] {
  const commit = (): void =>
    camera.request({
      position: readTriplet(position),
      target: readTriplet(target),
      fov: fov.value,
    });
  const position = axisTriplet({ step: 0.05 }, commit, commit);
  const target = axisTriplet({ step: 0.05 }, commit, commit);
  const fov = new NumberControl({
    value: camera.view.fov,
    min: MIN_FOV,
    max: MAX_FOV,
    step: 1,
    precision: 1,
    onChange: commit,
    live: commit,
  });

  const sync = (): void => {
    const view = camera.view;
    setTriplet(position, view.position);
    setTriplet(target, view.target);
    fov.setValue(view.fov);
  };
  camera.onChange(sync);
  sync();

  return [
    axisSection(t("field.position"), position),
    axisSection(t("viewport.cameraTarget"), target),
    fieldSection(t("viewport.cameraFov"), [[t("viewport.cameraFovAxis"), fov.element]]),
  ];
}
