# Room overview and Board layout

This branch adds an Overview for returning to a room. It opens the most recent unfinished branch surfaced for the room, or the most recently updated conversation in it. The learner can keep a short goal and jump from a topic to its Board section.

Board opens by topic. A material group appears once, with loose materials under Ungrouped. The grip reorders it within its topic. Free layout keeps the existing movable canvas. The focus control shows the card's links. Show all links gives the full view. A card's port draws a link or starts keyboard-friendly card selection. The resize corner keeps sizes within 220–520 pixels wide and 84–440 pixels high.

Threads, sources and notes can be placed inside each other on the Board. Dropping a card on another from its move handle opens a confirmation. The right-click menu also has an explicit placement action. Containment is a one-level arrangement for that room, independent of links and material contents. Collapse state, sizes, topic order and the goal are browser preferences. Free positions and material links use the existing server storage.

Creating an empty room from Rooms temporarily highlights the existing material picker. Opening the picker, skipping the invitation or leaving the room ends the prompt. In Concepts, a material dragged near the top or bottom of a long page scrolls that page. Wheel scrolling also works when the browser delivers a wheel event during native drag and drop.

The new browser scenarios cover reopening a saved goal and an exact side question, grouped layout, focused and full links, containment and collapse after reload, free movement, and both size limits. Existing test scenarios still cover room selection, links, Folders, Concepts, Path and doors. Browser tests use the fake model and in-memory notebook.

The Room and Board regression run passed all 20 browser scenarios. Type checking passed in all four projects, and the 24 room and concept core tests passed. The browser test for a repeated drag also verifies that Escape closes the link editor when the port still has focus.

The follow-up regression passed all 23 browser scenarios against the built branch. The new cases verify temporary picker emphasis, cancel and confirm for mixed-type containment without changing existing links, and dragging an unclassified material from the bottom to the top of Concepts. All four TypeScript projects passed again.
