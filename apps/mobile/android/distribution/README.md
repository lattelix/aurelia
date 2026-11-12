# Bounded Android runtime inventory

This external Gradle init task records the **selected app runtime graph**, not
an APK, source closure or distribution approval. It does not change dependencies,
locks, verification metadata, repositories, source flags or signing settings.
The helpers are source-review tooling; their presence does not approve a binary.

## Prerequisites and root-controlled execution

Use an already reviewed clean public source checkout with its exact npm install,
an explicit external **JDK 21**, Android SDK 37 and build tools 36.0.0. Complete SDK
installation/license setup separately. The project wrapper pins Gradle 9.4.1;
the init task uses public `ResolutionResult` and `ArtifactView` APIs. It never
uses the legacy source-artifact query API.

The coordinator controls any actual Gradle execution and network access. The
following is a recipe, not a claim that a resolution has run. Use a fresh isolated
`GRADLE_USER_HOME`; do not copy global Gradle configs, credentials, signing keys,
`google-services.json`, environment files or local SDK configuration from another
checkout. The capture helper executes the explicit argument vector with
`shell=False`, with no automatic retries or installations of its own.
Use POSIX Python (verified locally with Python 3.14.3). A supervisor in this same
file runs the command with `shell=False` and stays alive as its process-group
leader. Its private bounded pipe reports the command exit status; the capture
then cleans up that group, including descendants after normal command exits.

From the development checkout containing these helpers, replace only the three
prerequisite placeholders, then let the coordinator run the bounded command:

```sh
task_workspace="$(pwd -P)"
source_checkout="/absolute/path/to/clean-public-source-checkout"
export JAVA_HOME="/absolute/path/to/jdk-21/Contents/Home"
export ANDROID_SDK_ROOT="/absolute/path/to/android-sdk"
export PATH="$JAVA_HOME/bin:$PATH"
export GRADLE_USER_HOME="$task_workspace/.runtime/android-inventory-gradle-home"
inventory_dir="$task_workspace/.runtime/android-runtime-review"
mkdir -m 700 "$GRADLE_USER_HOME" "$inventory_dir"
inventory_init="$task_workspace/apps/mobile/android/distribution/runtime-inventory.init.gradle"
inventory_capture="$task_workspace/apps/mobile/android/distribution/capture-runtime-inventory.py"

cd "$source_checkout/apps/mobile/android"
python3 -B "$inventory_capture" \
  --output "$inventory_dir/release-runtime.json" --timeout-seconds 600 -- \
  sh ./gradlew --no-daemon --no-configuration-cache --console=plain --max-workers=1 \
  --init-script "$inventory_init" :app:aureliaRuntimeInventory
```

The output parent must already exist, be owned by the current UID, have no
group/other write permission and have no symlink in its ancestry. Output creation
is exclusive, owner-only and relative to a held parent directory descriptor.
Existing output files are never replaced. Keep the source snapshot hash and
these helper hashes with the coordinator's execution evidence.

Only `releaseRuntimeClasspath` is selected by default. A **separate** debug
capture is explicit; use a new output filename and append:

```sh
-PaureliaInventoryConfiguration=debugRuntimeClasspath
```

If reproducing a build with explicit native properties, pass its exact canonical
`-PaureliaYoutubeSource=true|false` and `-PaureliaSilentQa=true|false` values too.
The task records these two properties; neither filters the graph. A false source
capability does not remove the unconditional `:youtube-source` dependency.

## Output and refusal behavior

The Gradle task emits exactly one stdout marker containing base64 UTF-8 JSON.
The Python helper captures at most 12 MiB stdout and 2 MiB stderr, with a 600-second
default deadline and an explicit maximum of 1800 seconds. It controls only its own
child process group. Marker payloads are capped at 4 MiB; duplicate/missing markers,
invalid base64/JSON, unexpected claims and oversized data are rejected. Raw logs,
command arguments, environment values, cache paths and exception messages are
not included in the report or echoed by the helper.
Cleanup adds a 0.1-second TERM grace and at most a 5-second wait; a denied signal
or incomplete cleanup refuses the capture instead of claiming success.

The report contains resolved module/project identities, requested-to-selected
edges, dependency-constraint flags and selected variant attributes. External
module runtime artifacts carry only filename, size and SHA256, plus their module
identity/variant attributes. Project nodes remain present with
`projectArtifact: not-built`. The `ArtifactView` filters artifacts to external
`ModuleComponentIdentifier` components; no project AAR producer task is requested
and no application is compiled, signed, installed or played by the inventory task.

Limits are 300 external modules, 32 project nodes, 600 artifact attempts, 3000 edges,
128 MiB per artifact and 512 MiB total reserved artifact bytes. Each attempt reserves
its initial file size before reading; failures do not refund the budget, and reads
never exceed that initial size. These caps bound the
inventory/hash work, not Gradle's preceding configuration/download work; the
coordinator must also enforce its own disk reserve and process budget.

Lenient artifact collection is used only to retain failure diagnostics. Any
unresolved dependency, artifact failure, unsupported component/unsafe metadata or
limit failure produces a partial report and a failing task exit. Valid partial
protocol reports are persisted; a nonzero child exit cannot become a successful
capture. Startup/configuration errors before the task, missing markers, stream
limits or deadlines can leave no report; the helper never fabricates an empty
success. Error entries contain codes/classes, not raw Gradle failure messages.

Every report retains `sourceClosureComplete: false` and
`binaryReleaseReady: false`. Source/POM/module/license queries are deliberately
**not performed**. Selected coordinates or POM license labels alone do not prove
upstream source correspondence, complete notices, APK contents or permission to
distribute a linked binary. Those are separate reviewed steps after this graph.

No Gradle resolution or network operation is performed by merely adding these
files. Actual Gradle 9.4.1 execution and the resulting graph remain coordinator
verification gates.
