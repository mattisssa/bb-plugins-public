import { memo, useMemo } from "react";
import {
  arrowPath,
  boardInk,
  drawPath,
  isStroke,
  isTextElement,
  type CanvasElement,
} from "./model";
import { CanvasImage } from "./image-crop";
import { layoutSticky } from "./layout";

// Editing one note must not rebuild the other notes, images, or stroke paths.
export const CanvasArtwork = memo(function CanvasArtwork({
  element,
  threadId,
  zoom,
  editing,
}: {
  element: CanvasElement;
  threadId: string;
  zoom: number;
  editing: boolean;
}) {
  const layout = useMemo(
    () =>
      element.type === "sticky" && !editing ? layoutSticky(element) : null,
    [element, editing],
  );
  const stroke = isStroke(element) ? element : null;
  const path = useMemo(
    () =>
      stroke &&
      (stroke.type === "arrow" ? arrowPath(stroke) : drawPath(stroke)),
    [stroke?.type, stroke?.points, stroke?.strokeWidth],
  );
  return (
    <g data-element={element.id} data-element-type={element.type}>
      {element.type === "image" ? (
        <CanvasImage image={element} threadId={threadId} />
      ) : isTextElement(element) ? (
        <>
          <rect
            x={element.x + (element.type === "sticky" ? 0.5 : 0)}
            y={element.y + (element.type === "sticky" ? 0.5 : 0)}
            width={element.width - (element.type === "sticky" ? 1 : 0)}
            height={element.height - (element.type === "sticky" ? 1 : 0)}
            rx={element.type === "sticky" ? 8 : undefined}
            fill={
              element.type === "sticky" ? element.background : "transparent"
            }
            stroke={element.type === "sticky" ? "#242424" : undefined}
            strokeOpacity={0.12}
          />
          {!editing && (
            <text
              fontFamily="Canvas Sans, sans-serif"
              fontSize={layout?.fontSize ?? element.fontSize}
              style={
                layout
                  ? {
                      fontKerning: "none",
                      fontVariantLigatures: "none",
                      fontFeatureSettings: '"kern" 0, "liga" 0',
                    }
                  : undefined
              }
              fill={
                element.type === "sticky"
                  ? element.color
                  : boardInk(element.color)
              }
              xmlSpace="preserve"
            >
              {(layout?.lines ?? element.text.split("\n")).map(
                (line, index) => (
                  <tspan
                    key={index}
                    x={element.x + (layout?.padding ?? 0)}
                    y={
                      element.y +
                      (layout?.padding ?? 0) +
                      (layout?.fontSize ?? element.fontSize) * (1 + index * 1.3)
                    }
                  >
                    {line}
                  </tspan>
                ),
              )}
            </text>
          )}
        </>
      ) : (
        <g transform={`translate(${stroke!.x} ${stroke!.y})`}>
          <path
            d={path!}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(stroke!.strokeWidth, 12 / zoom)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={path!}
            fill="none"
            stroke={boardInk(stroke!.color)}
            strokeWidth={stroke!.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}
    </g>
  );
});
