import { defineAuth, defineBackend, defineDatabase, defineTable, DatabaseConflictError, s } from "clank";
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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vYmFja2VuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUNFLFVBQVUsRUFDVixhQUFhLEVBQ2IsY0FBYyxFQUNkLFdBQVcsRUFDWCxxQkFBcUIsRUFDckIsQ0FBQyxRQUVJLFFBQVE7QUFFZixNQUFNLGNBQWMsQUFBQyxXQUVsQixPQUFPLEVBQUU7QUFDWixNQUFNLGFBQWEsYUFBYSxxQkFBcUIsYUFBYTtBQUVsRSxPQUFPLE1BQU0sT0FBTyxXQUFXO0lBQzdCLHlGQUF5RjtJQUN6RixVQUFVLGFBQWE7UUFBRSxRQUFRO0lBQVcsSUFBSTtBQUNsRCxHQUFHO0FBRUgsT0FBTyxNQUFNLGlCQUFpQixlQUFlO0lBQzNDLFVBQVUsWUFBWTtRQUNwQixhQUFhLEVBQUUsTUFBTSxDQUFDO1lBQUUsS0FBSztZQUFHLEtBQUs7UUFBSTtJQUMzQyxHQUFHLEtBQUs7SUFDUixPQUFPLFlBQVk7UUFDakIsT0FBTyxFQUFFLE1BQU0sQ0FBQztZQUFFLEtBQUs7WUFBRyxLQUFLO1FBQUk7UUFDbkMsTUFBTSxFQUFFLE9BQU87SUFDakIsR0FDRyxLQUFLLEdBQ0wsS0FBSyxDQUFDLFdBQVc7UUFBQztLQUFPO0FBQzlCLEdBQUc7QUFLSCxNQUFNLGdCQUFnQixFQUFFLE1BQU0sQ0FDNUIsRUFBRSxNQUFNLENBQUM7SUFBRSxLQUFLO0FBQUksSUFDcEIsQ0FBQyxRQUFVLE1BQU0sSUFBSSxHQUFHLE1BQU0sR0FBRyxHQUNqQztBQUVGLE1BQU0sc0JBQXNCLEVBQUUsTUFBTSxDQUNsQyxFQUFFLE1BQU0sQ0FBQztJQUFFLEtBQUs7QUFBSSxJQUNwQixDQUFDLFFBQVUsTUFBTSxJQUFJLEdBQUcsTUFBTSxHQUFHLEdBQ2pDO0FBRUYsTUFBTSxrQkFBa0IsRUFBRSxNQUFNLENBQUM7SUFBRSxTQUFTO0lBQU0sS0FBSztBQUFFO0FBRXpELE9BQU8sTUFBTSxVQUFVLGNBQWM7SUFDbkMs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