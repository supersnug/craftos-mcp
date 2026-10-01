# Advanced Peripherals automata: ATM10 8.2

Verified on an in-game advanced turtle using CC:Tweaked 1.120.2 (Minecraft
1.21.1). ATM10's published mod list identifies Advanced Peripherals 0.8.1a;
the source references below are pinned to that release. The MCP discovers the
upgrade as `right`, with both `automata` and `weak_automata` types.

## Unnamed upgrade: `getName()` throws a Java NullPointerException

Reproduction:

```lua
local a = peripheral.wrap("right")
print(pcall(a.getName))
```

On the unnamed test upgrade this reports a Java exception involving
`String.getBytes` and a null `utf8String`. Setting a temporary name made
`getName()` return that name; clearing the name restored the original state.

Cause: `BasePeripheral.getName()` passes the nullable
`owner.getCustomName()` directly into `StringUtil.utf8ToByteString()`, which
calls `getBytes` without a null check.

For identification, use the exact peripheral attachment name reported by
`list_computers` (`right` here), not `getName()`. A custom display name is optional.
If a custom name is wanted, this workaround was verified in-game:

```lua
local a = peripheral.wrap("right")
a.setName("Workshop automata")
print(a.getName())
```

`a.setName("")` removes that custom name, but the underlying unnamed-name bug
then returns. A mod-side correction is to return Lua nil for an absent name
instead of calling the string converter:

```java
public final String getName() {
    String name = owner.getCustomName();
    return name == null ? null : StringUtil.utf8ToByteString(name);
}
```

## `lookAtBlock()` hits the turtle itself

With cobblestone directly in front, `turtle.inspect()` returned
`minecraft:cobblestone`, but `lookAtBlock()` returned
`computercraft:turtle_advanced`. Explicit yaw values 0, 90, 180 and -90 all
returned the turtle itself. Changing monitor placement did not change this.

In the release source, `FakePlayerProviderTurtle.load()` positions the fake
player at the turtle's center. `APFakePlayer.findHit()` passes its `source`
block into `HitResultUtil`, which excludes that block from the raycast. However,
the turtle provider never calls `setSourceBlock`, leaving `source` null. The
raycast therefore includes the turtle containing its origin.

For an adjacent block, this workaround was verified:

```lua
local found, block = turtle.inspect()
if found then print(block.name) else print(block) end
```

Use `turtle.inspectUp()` or `turtle.inspectDown()` for those adjacent directions.
These are not replacements for arbitrary-angle or longer-range automata
raycasts. The mod-side correction is to add this immediately after obtaining
the turtle's position in `FakePlayerProviderTurtle.load()`:

```java
player.setSourceBlock(position);
```

This must be refreshed on each load so the excluded block follows turtle
movement. A corrected mod build should verify forward cobblestone, upward
chest, rear monitor, empty space, and movement to another position.

The Java corrections above are source-level recommendations, not an installed
or build-tested replacement mod. The MCP transports these calls and their
results; it does not modify the mod's implementation or substitute results.

## Pinned sources

- [BasePeripheral.getName](https://github.com/IntelligenceModding/AdvancedPeripherals/blob/1.21.1-0.8.1a/src/main/java/de/srendi/advancedperipherals/lib/peripherals/BasePeripheral.java)
- [Nullable custom-name storage](https://github.com/IntelligenceModding/AdvancedPeripherals/blob/1.21.1-0.8.1a/src/main/java/de/srendi/advancedperipherals/common/addons/computercraft/owner/IPeripheralOwner.java)
- [String conversion](https://github.com/IntelligenceModding/AdvancedPeripherals/blob/1.21.1-0.8.1a/src/main/java/de/srendi/advancedperipherals/common/util/StringUtil.java)
- [Turtle fake-player setup](https://github.com/IntelligenceModding/AdvancedPeripherals/blob/1.21.1-0.8.1a/src/main/java/de/srendi/advancedperipherals/common/util/fakeplayer/FakePlayerProviderTurtle.java)
- [Fake-player raycast](https://github.com/IntelligenceModding/AdvancedPeripherals/blob/1.21.1-0.8.1a/src/main/java/de/srendi/advancedperipherals/common/util/fakeplayer/APFakePlayer.java)
- [Source-block exclusion](https://github.com/IntelligenceModding/AdvancedPeripherals/blob/1.21.1-0.8.1a/src/main/java/de/srendi/advancedperipherals/common/util/HitResultUtil.java)
