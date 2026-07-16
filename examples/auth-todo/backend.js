import { defineAuth, defineBackend, defineDatabase, defineTable, DatabaseConflictError, s } from "clank.run";
const environment = globalThis.process?.env;
const authPepper = environment?.CLANK_AUTH_PEPPER ?? environment?.PROACT_AUTH_PEPPER;
export const auth = defineAuth({
    // Keep the pepper server-only. The browser imports this module as a type, never as code.
    password: authPepper ? {
        pepper: authPepper
    } : undefined
});
export const databaseSchema = defineDatabase({
    profiles: defineTable({
        displayName: s.string({
            min: 1,
            max: 120
        })
    }).owned(),
    todos: defineTable({
        title: s.string({
            min: 1,
            max: 160
        }),
        done: s.boolean()
    }).owned().index("by_done", [
        "done"
    ])
});
const nonEmptyTitle = s.refine(s.string({
    max: 160
}), (value)=>value.trim().length > 0, "Todo titles cannot be empty.");
const nonEmptyDisplayName = s.refine(s.string({
    max: 120
}), (value)=>value.trim().length > 0, "Display names cannot be empty.");
const documentVersion = s.number({
    integer: true,
    min: 1
});
export const backend = defineBackend({
    schema: databaseSchema,
    auth
}).functions(({ query, mutation })=>({
        profile: {
            get: query({
                args: {},
                handler: ({ db })=>db.table("profiles").query().orderBy("_creationTime", "asc").first()
            }),
            update: mutation({
                args: {
                    displayName: nonEmptyDisplayName,
                    version: s.nullable(documentVersion)
                },
                handler: ({ db }, { displayName, version })=>{
                    const value = displayName.trim();
                    const profile = db.table("profiles").query().orderBy("_creationTime", "asc").first();
                    if (version === null) {
                        if (profile) {
                            throw new DatabaseConflictError("profiles", profile._id, null, profile._version);
                        }
                        return db.table("profiles").insert({
                            displayName: value
                        });
                    }
                    if (!profile) {
                        throw new DatabaseConflictError("profiles", "profile", version, null);
                    }
                    return db.table("profiles").patch(profile._id, {
                        displayName: value
                    }, {
                        ifVersion: version
                    });
                }
            })
        },
        todos: {
            list: query({
                args: {},
                handler: ({ db })=>db.table("todos").query().orderBy("_creationTime", "asc").collect()
            }),
            add: mutation({
                args: {
                    title: nonEmptyTitle
                },
                handler: ({ db }, { title })=>db.table("todos").insert({
                        title: title.trim(),
                        done: false
                    })
            }),
            setDone: mutation({
                args: {
                    id: s.id("todos"),
                    done: s.boolean(),
                    version: documentVersion
                },
                handler: ({ db }, { id, done, version })=>db.table("todos").patch(id, {
                        done
                    }, {
                        ifVersion: version
                    })
            }),
            rename: mutation({
                args: {
                    id: s.id("todos"),
                    title: nonEmptyTitle,
                    version: documentVersion
                },
                handler: ({ db }, { id, title, version })=>db.table("todos").patch(id, {
                        title: title.trim()
                    }, {
                        ifVersion: version
                    })
            }),
            remove: mutation({
                args: {
                    id: s.id("todos"),
                    version: documentVersion
                },
                handler: ({ db }, { id, version })=>db.table("todos").delete(id, {
                        ifVersion: version
                    })
            }),
            clearCompleted: mutation({
                args: {},
                handler: ({ db })=>{
                    const completed = db.table("todos").query().where("done", true).collect();
                    for (const todo of completed){
                        db.table("todos").delete(todo._id, {
                            ifVersion: todo._version
                        });
                    }
                    return completed.length;
                }
            })
        }
    }));


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vYmFja2VuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUNFLFVBQVUsRUFDVixhQUFhLEVBQ2IsY0FBYyxFQUNkLFdBQVcsRUFDWCxxQkFBcUIsRUFDckIsQ0FBQyxRQUVJLFlBQVk7QUFFbkIsTUFBTSxjQUFjLEFBQUMsV0FFbEIsT0FBTyxFQUFFO0FBQ1osTUFBTSxhQUFhLGFBQWEscUJBQXFCLGFBQWE7QUFFbEUsT0FBTyxNQUFNLE9BQU8sV0FBVztJQUM3Qix5RkFBeUY7SUFDekYsVUFBVSxhQUFhO1FBQUUsUUFBUTtJQUFXLElBQUk7QUFDbEQsR0FBRztBQUVILE9BQU8sTUFBTSxpQkFBaUIsZUFBZTtJQUMzQyxVQUFVLFlBQVk7UUFDcEIsYUFBYSxFQUFFLE1BQU0sQ0FBQztZQUFFLEtBQUs7WUFBRyxLQUFLO1FBQUk7SUFDM0MsR0FBRyxLQUFLO0lBQ1IsT0FBTyxZQUFZO1FBQ2pCLE9BQU8sRUFBRSxNQUFNLENBQUM7WUFBRSxLQUFLO1lBQUcsS0FBSztRQUFJO1FBQ25DLE1BQU0sRUFBRSxPQUFPO0lBQ2pCLEdBQ0csS0FBSyxHQUNMLEtBQUssQ0FBQyxXQUFXO1FBQUM7S0FBTztBQUM5QixHQUFHO0FBS0gsTUFBTSxnQkFBZ0IsRUFBRSxNQUFNLENBQzVCLEVBQUUsTUFBTSxDQUFDO0lBQUUsS0FBSztBQUFJLElBQ3BCLENBQUMsUUFBVSxNQUFNLElBQUksR0FBRyxNQUFNLEdBQUcsR0FDakM7QUFFRixNQUFNLHNCQUFzQixFQUFFLE1BQU0sQ0FDbEMsRUFBRSxNQUFNLENBQUM7SUFBRSxLQUFLO0FBQUksSUFDcEIsQ0FBQyxRQUFVLE1BQU0sSUFBSSxHQUFHLE1BQU0sR0FBRyxHQUNqQztBQUVGLE1BQU0sa0JBQWtCLEVBQUUsTUFBTSxDQUFDO0lBQUUsU0FBUztJQUFNLEtBQUs7QUFBRTtBQUV6RCxPQUFPLE1BQU0sVUFBVSxjQUFjO0lBQ25D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